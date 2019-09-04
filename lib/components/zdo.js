/* jshint node: true */
'use strict';

var Q = require('q'),
    Areq = require('areq'),
    ZSC = require('zstack-constants'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter;

var zdoHelper = require('./zdo_helper');

const requestFn = {}

function Zdo(controller) {
    EventEmitter.call(this);
    this.setMaxListeners(40)
    this._controller = controller;
    this._areq = new Areq(controller, 70000);
}

util.inherits(Zdo, EventEmitter);

/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
Zdo.prototype.request = function (apiName, valObj, callback) {
    var requestType = zdoHelper.getRequestType(apiName);

    var handler = requestFn[requestType]
    if(!handler) {
        callback(new Error('Unknown request type.'))
        return
    }
    handler(this, apiName, valObj, callback)
};

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/
Zdo.prototype._sendZdoRequestViaZnp = async function (apiName, valObj, callback) {
    var controller = this._controller
    try {
        const rsp = await controller._znp.zdoRequest(apiName, valObj)
        if (!error && apiName !== 'startupFromApp' && rsp.status !== 0)
            return callback(new Error('request unsuccess: ' + rsp.status), null)
        callback(null, rsp);
    } catch(error){
        callback(error, null);
    }
};

requestFn.rspless = function (self, apiName, valObj, callback) {
    return self._sendZdoRequestViaZnp(apiName, valObj, callback);
};

requestFn.generic = function (self, apiName, valObj, callback) {
    var deferred = Q.defer(),
        areq = self._areq,
        areqEvtKey = zdoHelper.generateEventOfRequest(apiName, valObj)


    if (areqEvtKey) {
        function handleAbort(){
            deferred.reject("__abort__")
        }
        var abortKey = zdoHelper.generateDstAddrOfRequest(valObj)
        if(abortKey) self.once(abortKey, handleAbort)
        areq.register(areqEvtKey, deferred, function (payload) {
            if(abortKey) self.removeListener(abortKey, handleAbort)
            areq.resolve(areqEvtKey, payload);
        });
    }

    self._sendZdoRequestViaZnp(apiName, valObj, function (err, rsp) {
        if (err)
            areq.reject(areqEvtKey, err);
    });

    return deferred.promise.nodeify(callback);
};

requestFn.special = function (self, apiName, valObj, callback) {
    if (apiName === 'serverDiscReq') {
        // broadcast, remote device may not response when no bits match in mask
        // listener at controller.on('ZDO:serverDiscRsp')
        return requestFn.rspless(self, 'serverDiscReq', valObj, callback);
    } else if (apiName === 'bindReq') {
        if (valObj.dstaddrmode === ZSC.AF.addressMode.ADDR_16BIT)
            callback(new Error('TI not support address 16bit mode.'));
        else
            return requestFn.rspless(self, 'bindReq', valObj, callback);
    } else if (apiName === 'mgmtPermitJoinReq') {
        if (valObj.dstaddr === 0xFFFC)  // broadcast to all routers (and coord), no waiting for AREQ rsp
            return requestFn.rspless(self, 'mgmtPermitJoinReq', valObj, callback);
        else
            return requestFn.generic(self, 'mgmtPermitJoinReq', valObj, callback);
    } else {
        callback(new Error('No such request.'));
    }
};

requestFn.concat = function (self, apiName, valObj, callback) {
    if (apiName === 'nwkAddrReq' || apiName === 'ieeeAddrReq')
        return requestFn._concatAddr(self, apiName, valObj, callback);
    else if (apiName === 'mgmtNwkDiscReq')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'networkcount',
            listcount: 'networklistcount',
            list: 'networklist'
        }, callback);
    else if (apiName === 'mgmtLqiReq')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'neighbortableentries',
            listcount: 'neighborlqilistcount',
            list: 'neighborlqilist'
        }, callback);
    else if (apiName === 'mgmtRtgReq')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'routingtableentries',
            listcount: 'routingtablelistcount',
            list: 'routingtablelist'
        }, callback);
    else if (apiName === 'mgmtBindRsp')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'bindingtableentries',
            listcount: 'bindingtablelistcount',
            list: 'bindingtablelist'
        }, callback);
    else
        callback(new Error('No such request.'));
};

requestFn._concatAddr = function (self, apiName, valObj, callback) {
    var totalToGet = null,
        accum = 0,
        nextIndex = valObj.startindex,
        reqObj = {
            reqtype: valObj.reqtype,
            startindex: valObj.startindex    // start from 0
        },
        finalRsp = {
            status: null,
            ieeeaddr: null,
            nwkaddr: null,
            startindex: valObj.startindex,
            numassocdev: null,
            assocdevlist: []
        };

    if (apiName === 'nwkAddrReq')
        reqObj.ieeeaddr = valObj.ieeeaddr;
    else
        reqObj.shortaddr = valObj.shortaddr;

    function recursiveRequest() {
        requestFn.generic(self, apiName, reqObj, function (err, rsp) {
            if (err) {
                callback(err, finalRsp);
            } else if (rsp.status !== 0) {
                callback(new Error('request unsuccess: ' + rsp.status), finalRsp);
            } else {
                finalRsp.status = rsp.status;
                finalRsp.ieeeaddr = finalRsp.ieeeaddr || rsp.ieeeaddr;
                finalRsp.nwkaddr = finalRsp.nwkaddr || rsp.nwkaddr;
                finalRsp.numassocdev = finalRsp.numassocdev || rsp.numassocdev;
                finalRsp.assocdevlist = finalRsp.assocdevlist.concat(rsp.assocdevlist);

                totalToGet = totalToGet || (finalRsp.numassocdev - finalRsp.startindex);    // compute at 1st rsp back
                accum = accum + rsp.assocdevlist.length;

                if (valObj.reqtype === 1 && accum < totalToGet) {  // extended, include associated devices
                    nextIndex = nextIndex + rsp.assocdevlist.length;
                    reqObj.startindex = nextIndex;
                    recursiveRequest();
                } else {
                    callback(null, finalRsp);
                }
            }
        });
    };

    recursiveRequest();
};

requestFn._concatList = function (self, apiName, valObj, listKeys, callback) {
    // valObj = { dstaddr[, scanchannels, scanduration], startindex }
    // listKeys = { entries: 'networkcount', listcount: 'networklistcount', list: 'networklist' };
    var totalToGet = null,
        accum = 0,
        nextIndex = valObj.startindex,
        reqObj = {
            dstaddr: valObj.dstaddr,
            scanchannels: valObj.scanchannels,
            scanduration: valObj.scanduration,
            startindex: valObj.startindex    // starts from 0
        },
        finalRsp = {
            srcaddr: null,
            status: null,
            startindex: valObj.startindex
        };

    finalRsp[listKeys.entries] = null;       // finalRsp.networkcount = null
    finalRsp[listKeys.listcount] = null;     // finalRsp.networklistcount = null
    finalRsp[listKeys.list] = [];            // finalRsp.networklist = []

    if (apiName === 'mgmtNwkDiscReq') {
        reqObj.scanchannels = valObj.scanchannels;
        reqObj.scanduration = valObj.scanduration;
    }

    function recursiveRequest () {
        requestFn.generic(self, apiName, reqObj, function (err, rsp) {
            if (err) {
                callback(err, finalRsp);
            } else if (rsp.status !== 0) {
                callback(new Error('request unsuccess: ' + rsp.status), finalRsp);
            } else {
                finalRsp.status = rsp.status;
                finalRsp.srcaddr = finalRsp.srcaddr || rsp.srcaddr;
                finalRsp[listKeys.entries] = finalRsp[listKeys.entries] || rsp[listKeys.entries];
                finalRsp[listKeys.listcount] = rsp[listKeys.listcount];
                finalRsp[listKeys.list] = finalRsp[listKeys.list].concat(rsp[listKeys.list]);

                totalToGet = totalToGet || (finalRsp[listKeys.entries] - finalRsp.startindex);
                accum = accum + rsp[listKeys.list].length;

                if (accum < totalToGet && rsp[listKeys.list].length) {
                    nextIndex = nextIndex + rsp[listKeys.list].length;
                    reqObj.startindex = nextIndex;
                    recursiveRequest();
                } else {
                    callback(null, finalRsp);
                }
            }
        });
    };

    recursiveRequest();
};

module.exports = Zdo;
