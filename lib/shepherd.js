/* jshint node: true */
'use strict';

const util = require('util'),
      EventEmitter = require('events'),
      ObjectDiff = require('object-diff'),
      Q = require('q-lite'),
      _ = require('busyman'),
      zclId = require('zcl-id'),
      proving = require('proving'),
      assert = require('assert'),
      debug = { shepherd: require('debug')('zigbee-shepherd') },
      init = require('./initializers/init_shepherd'),
      Controller = require('./components/controller'),
      eventHandlers = require('./components/event_handlers'),
      Devstore = require('./components/devstore'),
      Coordpoint = require('./model/coordpoint');

/*************************************************************************************************/
/*** ZShepherd Class                                                                           ***/
/*************************************************************************************************/
function ZShepherd(sp, opts, keystore) {
    // opts: { net: {} }
    EventEmitter.call(this);

    opts = opts || {};

    proving.object(opts, 'opts should be an object if gieven.');


    this.keystore = keystore.section("devices")
    this.devstore = new Devstore(this.keystore, this)

    /***************************************************/
    /*** Protected Members                           ***/
    /***************************************************/
    this._startTime = 0;
    this._enabled = false;
    this.controller = new Controller(this, sp);    // controller is the main actor
    this.controller.setNvParams(opts.net);
    this.af = null;

    this.acceptDevIncoming = this.acceptDevInterview = async function () {  // Override at will. arg1:devInfo
        await Q.delay(0)
        return true
    };

    /***************************************************/
    /*** Event Handlers (Ind Event Bridges)          ***/
    /***************************************************/
    eventHandlers.attachEventHandlers(this);

    this.controller.on('permitJoining', time => this.emit('permitJoining', time));

    this.on('ind:incoming', (dev) => {
        this.emit('ind', { type: 'devIncoming', endpoints: dev.getEndpointList(), data: dev.getIeeeAddr() });
    });

    this.on('ind:interview', (dev, status) => {
        this.emit('ind', { type: 'devInterview', status: status, data: dev });
    });

    this.on('ind:leaving', (epList, nwkAddr, ieeeAddr) => {
        this.emit('ind', { type: 'devLeaving', endpoints: epList, data: ieeeAddr });
    });

    this.on('ind:changed', (ep, notifData) => {
        this.emit('ind', { type: 'devChange', endpoints: [ ep ], data: notifData });
    });

    this.on('ind:dataConfirm', (ep, notifData) => {
        this.emit('ind', { type: 'dataConfirm', endpoints: [ ep ], data: notifData });
    });

    this.on('ind:statusChange', (ep, cId, payload, msg) => {
        var cIdString = zclId.cluster(cId),
            notifData = Object.assign({}, payload);

        cIdString = cIdString ? cIdString.key : cId;
        notifData.cid = cIdString;

        this.emit('ind', { type: 'statusChange', endpoints: [ ep ], data: notifData, msg: msg });
    });

    this.on('ind:reported', async (ep, cId, attrs) => {
        var cIdString = zclId.cluster(cId),
            notifData = {
                cid: '',
                data: {}
            };

        const finalizer = this._updateFinalizer(ep, cId, attrs, true);

        cIdString = cIdString ? cIdString.key : cId;
        notifData.cid = cIdString;

        _.forEach(attrs, function (rec) {  // { attrId, dataType, attrData }
            var attrIdString = zclId.attr(cIdString, rec.attrId);
            attrIdString = attrIdString ? attrIdString.key : rec.attrId;

            notifData.data[attrIdString] = rec.attrData;
        });

        this.emit('ind', { type: 'attReport', endpoints: [ ep ], data: notifData });

        await finalizer
    });

    this.on('ind:status', (dev, status) => {
        this.emit('ind', { type: 'devStatus', endpoints: dev.getEndpointList(), data: status });
    });
}

util.inherits(ZShepherd, EventEmitter);

/*************************************************************************************************/
/*** Public Methods                                                                            ***/
/*************************************************************************************************/
ZShepherd.prototype.start = async function () {
    debug.shepherd("starting")

    await this.devstore.refresh()
    await init.setupShepherd(this)
    this._enabled = true;   // shepherd is enabled
    this._startTime = Math.floor(Date.now()/1000);
    this.emit('ready');    // if all done, shepherd fires 'ready' event for inner use
    debug.shepherd("ready & enabled")
};

ZShepherd.prototype.stop = async function () {
    debug.shepherd("stopping")

    await this.controller.close();

    this._enabled = false;
    debug.shepherd("stopped")
}

ZShepherd.prototype.reset = async function (mode, clearDevices = false) {
    proving.stringOrNumber(mode, 'mode should be a number or a string.');

    if (mode === 'hard' || mode === 0) {
        // clear database
        if(clearDevices){
            await this.devstore.clear()
        }
    }

    return this.controller.reset(mode);
};

ZShepherd.prototype.permitJoin = function (time, type) {
    type = type || 'all';

    if (!this._enabled)
        throw new Error('Shepherd is not enabled.')
    return this.controller.permitJoin(time, type);
};

ZShepherd.prototype.info = function () {
    const net = this.controller.getNetInfo();
    const firmware = this.controller.getFirmwareInfo();
    const znp = this.controller.getZnpInfo()
    const controller = this.controller.getControllerInfo()
    return {
        enabled: this._enabled,
        net: {
            state: net.state,
            channel: net.channel,
            panId: net.panId,
            extPanId: net.extPanId,
            ieeeAddr: net.ieeeAddr,
            nwkAddr: net.nwkAddr,
        },
        firmware: firmware,
        startTime: this._startTime,
        joinTimeLeft: net.joinTimeLeft,
        znp,
        controller
    };
};

ZShepherd.prototype.mount = async function (zApp) {
    let coord = this.controller.getCoord(),
        loEp;

    assert (zApp.isZive && zApp.isZive(), 'zApp should be an instance of Zive class.')
    
    if (!coord) throw new Error('Coordinator has not been initialized yet.');

    const mountId = Math.max.apply(null, coord.epList);
    zApp._simpleDesc.epId = mountId > 10 ? mountId + 1 : 11;  // epId 1-10 are reserved for delegator
    loEp = new Coordpoint(coord, zApp._simpleDesc);
    loEp.clusters = zApp.clusters;
    zApp._endpoint = loEp;
        
    
    await this.controller.registerEp(loEp)
    debug.shepherd('Register zApp, epId: %s, profId: %s ', loEp.getEpId(), loEp.getProfId());
        
    const coordInfo = await this.controller.querie.coordInfo()

    await coord.update(coordInfo);
    coord.addEndpoint(loEp)

    this._attachZclMethods(zApp, true);

    loEp.onZclFoundation = async function (msg, remoteEp) {
        try {
            return await zApp.foundationHandler(msg, remoteEp);
        } catch(ex){
            debug.shepherd(`Zive failed to handle foundation due to ${ex}`)
        }
    }
    loEp.onZclFunctional = async function (msg, remoteEp) {
        try {
            return await zApp.functionalHandler(msg, remoteEp);
        } catch(ex){
            debug.shepherd(`Zive failed to handle functional due to ${ex}`)
        }
    }
    loEp.isZive = ()=>true

    return loEp.getEpId()
};

ZShepherd.prototype.list = async function (ieeeAddrs, showIncomplete = false) {
    if (_.isString(ieeeAddrs))
        ieeeAddrs = [ ieeeAddrs ];
    else if (!_.isUndefined(ieeeAddrs) && !_.isArray(ieeeAddrs))
        throw new TypeError('ieeeAddrs should be a string or an array of strings if given.');

    let foundDevs = []
    for(const dev of this.devstore.all()){
        if(dev.complete || showIncomplete){
            if(!ieeeAddrs || ieeeAddrs.includes(dev.ieeeAddr)){
                foundDevs.push(dev)
            }
        }
    }

    return foundDevs;
};

ZShepherd.prototype._onDeviceWrite = async function(){
    await this.devstore.refresh()
}

ZShepherd.prototype.find = function (addr, epId) {
    proving.number(epId, 'epId should be a number.');

    var dev = this.findDevByAddr(addr);
    return dev ? dev.getEndpoint(epId) : undefined;
};

ZShepherd.prototype.rtg = async function (ieeeAddr) {
    proving.string(ieeeAddr, 'ieeeAddr should be a string.');

    var dev = this.findDevByAddr(ieeeAddr);

    if(!dev) throw new Error('device is not found.')

    const rsp = await this.controller.request('ZDO', 'mgmtRtgReq', { dstaddr: dev.getNwkAddr(), startindex: 0 });
    if (rsp.status === 0)  // success
    return _.map(rsp.routingtablelist, function (neighbor) {
        if((neighbor.routeStatus & 7) == 3) return null
        return neighbor 
    }).filter(function (el) { return el != null; });
};

ZShepherd.prototype.lqi = async function (ieeeAddr) {
    proving.string(ieeeAddr, 'ieeeAddr should be a string.');

    const dev = this.findDevByAddr(ieeeAddr);
    if (!dev) throw new Error(`device "${ieeeAddr}" is not found.`)

    const rsp = await this.controller.request('ZDO', 'mgmtLqiReq', { dstaddr: dev.getNwkAddr(), startindex: 0 });
    
    // { srcaddr, status, neighbortableentries, startindex, neighborlqilistcount, neighborlqilist }
    if (rsp.status !== 0)  return null// success
    return _.map(rsp.neighborlqilist, function (neighbor) {
        return { ieeeAddr: neighbor.extAddr, nwkAddr: neighbor.nwkAddr, lqi: neighbor.lqi };
    });
};

ZShepherd.prototype.remove = async function (ieeeAddr, cfg) {
    proving.string(ieeeAddr, 'ieeeAddr should be a string.');

    var dev = this.findDevByAddr(ieeeAddr);

    cfg = cfg || {};

    if (!dev)
        throw new Error('device is not found.')
    
    return await this.controller.remove(dev, cfg);
};

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/
ZShepherd.prototype.findDevByAddr = function (addr) {
    const coord = this.controller.getCoord()
    if(addr == 0 || (coord && addr == coord.getIeeeAddr())) return coord

    return this.devstore.find(addr)
};

ZShepherd.prototype._attachZclMethods = function (ep, isZive = false) {
    assert(!isZive || ep.isZive(), 'should be Zive')
    if (isZive) {
        ep.foundation = async (_, dstAddr, dstEpId, cId, cmd, zclData, cfg) => {
            var dstEp = (typeof dstEpId == 'object') ? dstEpId : this.find(dstAddr, dstEpId);

            if (!dstEp)
                throw new Error('dstEp is not found.')
                
            return this._foundation(ep._endpoint, dstEp, cId, cmd, zclData, cfg);
        };

        ep.functional = async (_, dstAddr, dstEpId, cId, cmd, zclData, cfg) => {
            var dstEp = (typeof dstEpId == 'object') ? dstEpId : this.find(dstAddr, dstEpId);

            if (!dstEp)
                throw new Error('dstEp is not found.')
            
            return await this._functional(ep._endpoint, dstEp, cId, cmd, zclData, cfg);
        };
    }
};

ZShepherd.prototype._foundation = async function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    cfg = cfg || {};

    if(!srcEp) srcEp = this.controller.getCoord().getDelegator()
    const msg = await this.af.zclFoundation(srcEp, dstEp, cId, cmd, zclData, cfg)
    var cmdString = zclId.foundation(cmd);
    cmdString = cmdString ? cmdString.key : cmd;

    if(cfg.skipFinalize === false){
        if (cmdString === 'read')
            await this._updateFinalizer(dstEp, cId, msg.payload);
        else if (cmdString === 'write' || cmdString === 'writeUndiv' || cmdString === 'writeNoRsp')
            await this._updateFinalizer(dstEp, cId);
    }

    if(cfg.direction == 1 || cfg.response) return null
    return msg ? msg.payload: undefined;
        
};

ZShepherd.prototype._functional = async function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    cfg = cfg || {};
            
    if (typeof zclData !== 'object' || zclData === null)
        throw new TypeError(`zclData should be an object or an array (was ${typeof zclData})`);

    if(!srcEp) srcEp = this.controller.getCoord().getDelegator()
    const msg = await this.af.zclFunctional(srcEp, dstEp, cId, cmd, zclData, cfg)
    if(cfg.skipFinalize === false){
        await this._updateFinalizer(dstEp, cId);
    }
    
    return msg ? msg.payload : undefined;
};

ZShepherd.prototype._updateFinalizer = async function (ep, cId, attrs, reported) {
    var cIdString = zclId.cluster(cId),
        clusters = ep.getClusters()

    if(!clusters) return
    clusters = clusters.dumpSync();

    cIdString = cIdString ? cIdString.key : cId;

    var newAttrs = {};
    try {
        if (attrs) {
            for(const rec of attrs) {  // { attrId, status, dataType, attrData }
                var attrIdString = zclId.attr(cId, rec.attrId);
                attrIdString = attrIdString ? attrIdString.key : rec.attrId;

                if (reported)
                    newAttrs[attrIdString] = rec.attrData;
                else
                    newAttrs[attrIdString] = (rec.status === 0) ? rec.attrData : null;
            }
        } else {
            newAttrs = await this.af._zclClusterAttrsReq(this.controller.getCoord().getDelegator(), ep, cId);
        }
    } catch(ex){
        return
    }

    if(clusters[cIdString]){
        var oldAttrs = clusters[cIdString].attrs,
            diff = ObjectDiff(oldAttrs, newAttrs);

        if (_.isEmpty(diff)) return
        _.forEach(diff, (val, attrId) => {
            ep.getClusters().set(cIdString, 'attrs', attrId, val);
        });

        this.emit('ind:changed', ep, { cid: cIdString, data: diff });
    }
};

ZShepherd.prototype.interestedEndpoint = function(){ //args: endpoint, basicData
    // Can be overridden
    return true
}

module.exports = ZShepherd;