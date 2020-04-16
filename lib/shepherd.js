/* jshint node: true */
'use strict';

var fs = require('fs'),
    util = require('util'),
    EventEmitter = require('events');

var Q = require('q'),
    _ = require('busyman'),
    zclId = require('zcl-id'),
    proving = require('proving'),
    ObjectBox = require('objectbox'),
    assert = require('assert'),
    debug = { shepherd: require('debug')('zigbee-shepherd') };

var init = require('./initializers/init_shepherd'),
    zutils = require('zstack-common').utils,
    Controller = require('./components/controller'),
    eventHandlers = require('./components/event_handlers'),
    ZigbeeError = require('./errors/zigbee_error');

var Device = require('./model/device'),
    Coordinator = require('./model/coord'),
    Coordpoint = require('./model/coordpoint');

/*************************************************************************************************/
/*** ZShepherd Class                                                                           ***/
/*************************************************************************************************/
function ZShepherd(sp, opts) {
    // opts: { net: {}, dbPath: 'xxx' }
    EventEmitter.call(this);

    opts = opts || {};

    proving.object(opts, 'opts should be an object if gieven.');

    /***************************************************/
    /*** Protected Members                           ***/
    /***************************************************/
    this._startTime = 0;
    this._enabled = false;
    this._zApp = [];
    this.controller = new Controller(this, sp);    // controller is the main actor
    this.controller.setNvParams(opts.net);
    this.af = null;

    this._dbPath = opts.dbPath;

    if (!this._dbPath) {    // use default
        this._dbPath = __dirname + '/database/dev.db';
        // create default db folder if not there
        try {
            fs.statSync(__dirname + '/database');
        } catch (e) {
            fs.mkdirSync(__dirname + '/database');
        }
    }

    this._devbox = new ObjectBox(this._dbPath);

    this.acceptDevIncoming = this.acceptDevInterview = async function (devInfo) {  // Override at will.
        await Q.delay(0)
        return true
    };

    /***************************************************/
    /*** Event Handlers (Ind Event Bridges)          ***/
    /***************************************************/
    eventHandlers.attachEventHandlers(this);

    this.controller.on('permitJoining', time => this.emit('permitJoining', time));

    this.on('_ready', (generateEvent) => {
        this._startTime = Math.floor(Date.now()/1000);
        if(generateEvent){
            setImmediate(() => {
                this.emit('ready');
            });
        }
    });

    this.on('ind:incoming', (dev) => {
        var endpoints = [];

        _.forEach(dev.epList, function (epId) {
            endpoints.push(dev.getEndpoint(epId));
        });

        this.emit('ind', { type: 'devIncoming', endpoints: endpoints, data: dev.getIeeeAddr() });
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

        await this._updateFinalizer(ep, cId, attrs, true);

        cIdString = cIdString ? cIdString.key : cId;
        notifData.cid = cIdString;

        _.forEach(attrs, function (rec) {  // { attrId, dataType, attrData }
            var attrIdString = zclId.attr(cIdString, rec.attrId);
            attrIdString = attrIdString ? attrIdString.key : rec.attrId;

            notifData.data[attrIdString] = rec.attrData;
        });

        this.emit('ind', { type: 'attReport', endpoints: [ ep ], data: notifData });
    });

    this.on('ind:status', (dev, status) => {
        var endpoints = [];

        _.forEach(dev.epList, function (epId) {
            endpoints.push(dev.getEndpoint(epId));
        });

        this.emit('ind', { type: 'devStatus', endpoints: endpoints, data: status });
    });
}

util.inherits(ZShepherd, EventEmitter);

/*************************************************************************************************/
/*** Public Methods                                                                            ***/
/*************************************************************************************************/
ZShepherd.prototype.start = async function (generateEvent = true) {
    debug.shepherd("starting")

    await init.setupShepherd(this)
    this._enabled = true;   // shepherd is enabled
    this.emit('_ready', generateEvent);    // if all done, shepherd fires '_ready' event for inner use
    debug.shepherd("ready & enabled")
};

ZShepherd.prototype.stop = async function () {
    debug.shepherd("stopping")

    if (this._enabled) {
        _.forEach(this._devbox.exportAllIds(), (id)=> {
            this._devbox.removeElement(id);
        })
    }
    await this.controller.close();

    this._enabled = false;
    this._zApp = [];
    debug.shepherd("stopped")
}

ZShepherd.prototype.reset = function (mode) {
    var devbox = this._devbox,
        removeDevs = [];

    proving.stringOrNumber(mode, 'mode should be a number or a string.');

    if (mode === 'hard' || mode === 0) {
        // clear database
        if (this._devbox) {
            _.forEach(devbox.exportAllIds(), function (id) {
                removeDevs.push(Q.ninvoke(devbox, 'remove', id));
            });

            Q.all(removeDevs).then(function () {
                if (devbox.isEmpty())
                    debug.shepherd('Database cleared.');
                else
                    debug.shepherd('Database not cleared.');
            }).catch(function (err) {
                debug.shepherd(err);
            });
        } else {
            devbox = new Objectbox(this._dbPath);
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
    var net = this.controller.getNetInfo();
    var firmware = this.controller.getFirmwareInfo();

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
        joinTimeLeft: net.joinTimeLeft
    };
};

ZShepherd.prototype.mount = async function (zApp) {
    let coord = this.controller.getCoord(),
        loEp;

    assert (zApp.isZive && zApp.isZive(), 'zApp should be an instance of Zive class.')

    for(const app of this._zApp){
        if (app === zApp)
            throw new  Error('zApp already exists.');
    }
    this._zApp.push(zApp);
    
    if (coord) {
        const mountId = Math.max.apply(null, coord.epList);
        zApp._simpleDesc.epId = mountId > 10 ? mountId + 1 : 11;  // epId 1-10 are reserved for delegator
        loEp = new Coordpoint(coord, zApp._simpleDesc);
        loEp.clusters = zApp.clusters;
        coord.endpoints[loEp.getEpId()] = loEp;
        zApp._endpoint = loEp;
    } else {
        throw new Error('Coordinator has not been initialized yet.');
    }
    
    await this.controller.registerEp(loEp)
    debug.shepherd('Register zApp, epId: %s, profId: %s ', loEp.getEpId(), loEp.getProfId());
        
    const coordInfo = await this.controller.querie.coordInfo()

    coord.update(coordInfo);
    coord.addEndpoint(loEp)
    await Q.ninvoke(this._devbox, 'sync', coord._id);

    
    this._attachZclMethods(loEp);
    this._attachZclMethods(zApp, true);

    loEp.onZclFoundation = function (msg, remoteEp) {
        return zApp.foundationHandler(msg, remoteEp);
    };
    loEp.onZclFunctional = function (msg, remoteEp) {
        return zApp.functionalHandler(msg, remoteEp);
    };

    return loEp.getEpId()
};

ZShepherd.prototype.list = function (ieeeAddrs, showIncomplete = false) {
    if (_.isString(ieeeAddrs))
        ieeeAddrs = [ ieeeAddrs ];
    else if (!_.isUndefined(ieeeAddrs) && !_.isArray(ieeeAddrs))
        throw new TypeError('ieeeAddrs should be a string or an array of strings if given.');
    else if (!ieeeAddrs)
        ieeeAddrs = _.map(this._devbox.exportAllObjs().filter(function(a){return showIncomplete || !a.incomplete}), function (dev) {
            return dev.getIeeeAddr();  // list all
        });

    let foundDevs = _.map(ieeeAddrs, (ieeeAddr) => {
        proving.string(ieeeAddr, 'ieeeAddr should be a string.');

        var devInfo,
            found = this._findDevByAddr(ieeeAddr);

        if (found) {
            devInfo = _.omit(found.dump(), [ 'id' ]);
            devInfo.epList = found.epList
        }

        return devInfo;  // will push undefined to foundDevs array if not found
    });

    return foundDevs;
};

ZShepherd.prototype.find = function (addr, epId) {
    proving.number(epId, 'epId should be a number.');

    var dev = this._findDevByAddr(addr);
    return dev ? dev.getEndpoint(epId) : undefined;
};

ZShepherd.prototype.rtg = async function (ieeeAddr) {
    proving.string(ieeeAddr, 'ieeeAddr should be a string.');

    var dev = this._findDevByAddr(ieeeAddr);

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

    var dev = this._findDevByAddr(ieeeAddr);

    if (!dev) throw new Error('device is not found.')
    const rsp = await this.controller.request('ZDO', 'mgmtLqiReq', { dstaddr: dev.getNwkAddr(), startindex: 0 });
    
    // { srcaddr, status, neighbortableentries, startindex, neighborlqilistcount, neighborlqilist }
    if (rsp.status !== 0)  return null// success
    return _.map(rsp.neighborlqilist, function (neighbor) {
        return { ieeeAddr: neighbor.extAddr, nwkAddr: neighbor.nwkAddr, lqi: neighbor.lqi };
    });
};

ZShepherd.prototype.remove = async function (ieeeAddr, cfg) {
    proving.string(ieeeAddr, 'ieeeAddr should be a string.');

    var dev = this._findDevByAddr(ieeeAddr);

    cfg = cfg || {};

    if (!dev)
        throw new Error('device is not found.')
    
    return this.controller.remove(dev, cfg);
};

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/
ZShepherd.prototype._findDevByAddr = function (addr) {
    // addr: ieeeAddr(String) or nwkAddr(Number)
    proving.stringOrNumber(addr, 'addr should be a number or a string.');

    return this._devbox.find(function (dev) {
        return _.isString(addr) ? dev.getIeeeAddr() === addr : dev.getNwkAddr() === addr;
    });
};

ZShepherd.prototype._registerDev = async function (dev) {
    var devbox = this._devbox,
        oldDev, id;

    if (!(dev instanceof Device) && !(dev instanceof Coordinator))
        throw new TypeError('dev should be an instance of Device class.');

    oldDev = dev._id === null ? undefined : devbox.get(dev._id);

    if (oldDev) throw new Error('dev exists, unregister it first.')

    if (dev._recovered) {
        id = await Q.ninvoke(devbox, 'set', dev._id, dev)
        dev._recovered = false;
        delete dev._recovered;
    } else {
        dev.update({ joinTime: Math.floor(Date.now()/1000) });
        id = await Q.ninvoke(devbox, 'add', dev)
        dev._id = id;
    }
    return id;
};

ZShepherd.prototype.clearDev = async function (dev) {
    return await Q.ninvoke(this._devbox, 'remove', dev)
};

ZShepherd.prototype._unregisterDev = async function (dev) {
    return await this.clearDev(dev._id);
};

ZShepherd.prototype._attachZclMethods = function (ep, isZive = false) {
    assert(!isZive || ep.isZive(), 'should be Zive')
    if (isZive) {
        ep.foundation = (dstAddr, dstEpId, cId, cmd, zclData, cfg) => {
            var dstEp = this.find(dstAddr, dstEpId);

            if (!dstEp)
                throw new Error('dstEp is not found.')
                
            return this._foundation(ep._endpoint, dstEp, cId, cmd, zclData, cfg);
        };

        ep.functional = (dstAddr, dstEpId, cId, cmd, zclData, cfg) => {
            var dstEp = this.find(dstAddr, dstEpId);

            if (!dstEp)
                throw new Error('dstEp is not found.')
            
            return this._functional(ep._endpoint, dstEp, cId, cmd, zclData, cfg);
        };
    } else {
        ep.foundation = (cId, cmd, zclData, cfg) => {
            return this._foundation(null, ep, cId, cmd, zclData, cfg);
        };
        ep.functional = (cId, cmd, zclData, cfg) => {
            return this._functional(null, ep, cId, cmd, zclData, cfg);
        };
        ep.bind = (cId, dstEpOrGrpId) => {
            return this.controller.bind(ep, cId, dstEpOrGrpId);
        };
        ep.unbind = (cId, dstEpOrGrpId) => {
            return this.controller.unbind(ep, cId, dstEpOrGrpId);
        };
        ep.read = async (cId, attrId) => {
            var attr = zclId.attr(cId, attrId);

            attr = attr ? attr.value : attrId;

            const readStatusRecsRsp = await this._foundation(ep, ep, cId, 'read', [{ attrId: attr }])
            var rec = readStatusRecsRsp[0];

            if (rec.status) throw new ZigbeeError('request unsuccess: ' + rec.status, rec.status);
            return rec.attrData;
                
        };
        ep.write = async (cId, attrId, data) => {
            var attr = zclId.attr(cId, attrId),
                attrType = zclId.attrType(cId, attrId).value;

            const writeStatusRecsRsp = await this._foundation(ep, ep, cId, 'write', [{ attrId: attr.value, dataType: attrType, attrData: data }])
            var rec = writeStatusRecsRsp[0];

            if (rec.status)
                throw new ZigbeeError('request unsuccess: ' + rec.status, rec.status)
            return data;
        };
        ep.report = async (cId, attrId, minInt, maxInt, repChange) => {
            let coord = this.controller.getCoord(),
                dlgEp = coord.getDelegator(ep.getProfId()),
                cfgRpt = true,
                cfgRptRec,
                attrIdVal;
            if (arguments.length <= 2) {
                cfgRpt = false;
            }

            if (cfgRpt) {
                attrIdVal = zclId.attr(cId, attrId);
                cfgRptRec = {
                    direction : 0,
                    attrId: attrIdVal ? attrIdVal.value : attrId,
                    dataType : zclId.attrType(cId, attrId).value,
                    minRepIntval : minInt,
                    maxRepIntval : maxInt,
                    repChange: repChange
                };
            }

            if (!dlgEp) throw new Error('Profile: ' + ep.getProfId() + ' is not supported.');
            await ep.bind(cId, dlgEp)
            if (cfgRpt){
                const rsp = await ep.foundation(cId, 'configReport', [ cfgRptRec ])
                var status = rsp[0].status;
                if (status !== 0)
                    throw new Error(zclId.status(status).key);
            }
        };
    }
};

ZShepherd.prototype._foundation = async function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    cfg = cfg || {};

    if(!srcEp) this.controller.getCoord().getDelegator()
    const msg = await this.af.zclFoundation(srcEp, dstEp, cId, cmd, zclData, cfg)
    var cmdString = zclId.foundation(cmd);
    cmdString = cmdString ? cmdString.key : cmd;

    if(cfg.skipFinalize === false){
        if (cmdString === 'read')
            await this._updateFinalizer(dstEp, cId, msg.payload);
        else if (cmdString === 'write' || cmdString === 'writeUndiv' || cmdString === 'writeNoRsp')
            await this._updateFinalizer(dstEp, cId);
    }

    return msg.payload;
        
};

ZShepherd.prototype._functional = async function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    cfg = cfg || {};
            
    if (typeof zclData !== 'object' || zclData === null)
        throw new TypeError(`zclData should be an object or an array (was ${typeof zclData})`);

    if(!srcEp) this.controller.getCoord().getDelegator()
    const msg = await this.af.zclFunctional(srcEp, dstEp, cId, cmd, zclData, cfg)
    if(cfg.skipFinalize === false){
        await this._updateFinalizer(dstEp, cId);
    }
    return msg.payload
};

ZShepherd.prototype._updateFinalizer = async function (ep, cId, attrs, reported) {
    var cIdString = zclId.cluster(cId),
        clusters = ep.getClusters().dumpSync();

    cIdString = cIdString ? cIdString.key : cId;

    var newAttrs = {};
    try {
        if (attrs) {
            _.forEach(attrs, function (rec) {  // { attrId, status, dataType, attrData }
                var attrIdString = zclId.attr(cId, rec.attrId);
                attrIdString = attrIdString ? attrIdString.key : rec.attrId;

                if (reported)
                    newAttrs[attrIdString] = rec.attrData;
                else
                    newAttrs[attrIdString] = (rec.status === 0) ? rec.attrData : null;
            });
        } else {
            newAttrs = await this.af._zclClusterAttrsReq(this.controller.getCoord().getDelegator(), ep, cId);
        }
    } catch(ex){
        return
    }

    if(clusters[cIdString]){
        var oldAttrs = clusters[cIdString].attrs,
            diff = zutils.objectDiff(oldAttrs, newAttrs);

        if (_.isEmpty(diff)) return
        _.forEach(diff, (val, attrId) => {
            ep.getClusters().set(cIdString, 'attrs', attrId, val);
        });

        this.emit('ind:changed', ep, { cid: cIdString, data: diff });
    }
};

module.exports = ZShepherd;