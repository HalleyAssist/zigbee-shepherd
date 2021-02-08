/* jshint node: true */
'use strict';

const EventEmitter = require('eventemitter2'),
      CCZnp = require('cc-znp'),
      ZSC = CCZnp.constants,
      zdoHelper = require('./zdo_helper'),
      ZigbeeError = require('../errors/zigbee_error');

const requestFn = {}

const ZdoTimeout = 60000

class Zdo extends EventEmitter {
    constructor(controller){
        super()
        this.setMaxListeners(40)
        this._controller = controller;
    }

    /*************************************************************************************************/
    /*** Public APIs                                                                               ***/
    /*************************************************************************************************/
    async request (apiName, valObj) {
        var requestType = zdoHelper.getRequestType(apiName);
    
        var handler = requestFn[requestType]
        if(!handler) {
            throw new Error('Unknown request type.')
        }
        return await handler(this, apiName, valObj)
    }

    
    /*************************************************************************************************/
    /*** Protected Methods                                                                         ***/
    /*************************************************************************************************/
    async _sendZdoRequestViaZnp (apiName, valObj) {
        const rsp = await this._controller._znp.zdoRequest(apiName, valObj)
        if(!rsp){
            throw new Error(`Unable to execute ${apiName}`)
        }
        if (apiName !== 'startupFromApp' && rsp.status)
            throw new ZigbeeError('request unsuccess: ' + rsp.status, rsp.status)
        return rsp
    }
}

requestFn.rspless = function (self, apiName, valObj) {
    return self._sendZdoRequestViaZnp(apiName, valObj);
}

requestFn.generic = async function (self, apiName, valObj) {
    var areq,
        areqEvtKey = zdoHelper.generateEventOfRequest(apiName, valObj),
        abortKey,
        abortPromiseCancelable,
        abortPromise

    if (areqEvtKey) {
        abortKey = zdoHelper.generateDstAddrOfRequest(valObj)
        areq = self._controller.waitFor(areqEvtKey, ZdoTimeout)
        if(abortKey) {
            abortPromiseCancelable = self.waitFor(abortKey)
            abortPromise = abortPromiseCancelable.then(()=>{throw new Error("__abort__")}, ()=>{})
        }

    }

    const promises = []
    if(abortPromise){
        promises.push(abortPromise)
    }
    try {
        promises.push(self._sendZdoRequestViaZnp(apiName, valObj))
        await Promise.race(promises)
    } catch(err){
        if(areq) areq.cancel()
        if(abortPromiseCancelable) abortPromiseCancelable.cancel()
        throw err
    }

    let ret
    try {
        promises[promises.length - 1] = areq
        await Promise.race(promises)
        ret = await areq
    } finally {
        if(areq) areq.cancel()
        if(abortPromiseCancelable) abortPromiseCancelable.cancel()
    }

    return ret[0]
}

requestFn.special = function (self, apiName, valObj) {
    if (apiName === 'serverDiscReq') {
        // broadcast, remote device may not response when no bits match in mask
        // listener at controller.on('ZDO:serverDiscRsp')
        return requestFn.rspless(self, 'serverDiscReq', valObj);
    } else if (apiName === 'bindReq') {
        if (valObj.dstaddrmode === ZSC.AF.addressMode.ADDR_16BIT)
            throw new Error('TI not support address 16bit mode.');
        else
            return requestFn.rspless(self, 'bindReq', valObj);
    } else if (apiName === 'mgmtPermitJoinReq') {
        if (valObj.dstaddr === 0xFFFC)  // broadcast to all routers (and coord), no waiting for AREQ rsp
            return requestFn.rspless(self, 'mgmtPermitJoinReq', valObj);
        else
            return requestFn.generic(self, 'mgmtPermitJoinReq', valObj);
    } else {
        throw new Error('No such request.')
    }
}

requestFn.concat = function (self, apiName, valObj) {
    if (apiName === 'nwkAddrReq' || apiName === 'ieeeAddrReq')
        return requestFn._concatAddr(self, apiName, valObj);
    else if (apiName === 'mgmtNwkDiscReq')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'networkcount',
            listcount: 'networklistcount',
            list: 'networklist'
        });
    else if (apiName === 'mgmtLqiReq')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'neighbortableentries',
            listcount: 'neighborlqilistcount',
            list: 'neighborlqilist'
        });
    else if (apiName === 'mgmtRtgReq')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'routingtableentries',
            listcount: 'routingtablelistcount',
            list: 'routingtablelist'
        });
    else if (apiName === 'mgmtBindRsp')
        return requestFn._concatList(self, apiName, valObj, {
            entries: 'bindingtableentries',
            listcount: 'bindingtablelistcount',
            list: 'bindingtablelist'
        });
    else
        throw new Error('No such request.');
}

requestFn._concatAddr = function (self, apiName, valObj) {
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

    async function recursiveRequest() {
        const rsp = await requestFn.generic(self, apiName, reqObj)
        if (rsp.status) {
            throw new ZigbeeError('request unsuccess: ' + rsp.status, rsp.status)
        }
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
            return await recursiveRequest();
        }
        return finalRsp
    }

    return recursiveRequest();
}

requestFn._concatList = function (self, apiName, valObj, listKeys) {
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

    async function recursiveRequest () {
        const rsp = await requestFn.generic(self, apiName, reqObj)
        if (rsp.status)
            throw new ZigbeeError('request unsuccess: ' + rsp.status, rsp.status)

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
            return recursiveRequest();
        }
        return finalRsp
    }

    return recursiveRequest();
}

module.exports = Zdo;