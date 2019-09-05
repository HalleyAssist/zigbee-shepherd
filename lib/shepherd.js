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
    debug = { shepherd: require('debug')('zigbee-shepherd') };

var init = require('./initializers/init_shepherd'),
    zutils = require('./components/zutils'),
    Controller = require('./components/controller'),
    eventHandlers = require('./components/event_handlers');

var Device = require('./model/device'),
    Coordinator = require('./model/coord'),
    Coordpoint = require('./model/coordpoint');

/*************************************************************************************************/
/*** ZShepherd Class                                                                           ***/
/*************************************************************************************************/
function ZShepherd(sp, opts) {
    // opts: { net: {}, dbPath: 'xxx' }
    var self = this

    EventEmitter.call(this);

    opts = opts || {};

    proving.object(opts, 'opts should be an object if gieven.');

    /***************************************************/
    /*** Protected Members                           ***/
    /***************************************************/
    this._startTime = 0;
    this._enabled = false;
    this._zApp = [];
    this._mounting = false;
    this._mountQueue = [];
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

    this.controller.on('permitJoining', function (time) {
        self.emit('permitJoining', time);
    });

    this.on('_ready', function (generateEvent) {
        self._startTime = Math.floor(Date.now()/1000);
        if(generateEvent){
            setImmediate(function () {
                self.emit('ready');
            });
        }
    });

    this.on('ind:incoming', function (dev) {
        var endpoints = [];

        _.forEach(dev.epList, function (epId) {
            endpoints.push(dev.getEndpoint(epId));
        });

        self.emit('ind', { type: 'devIncoming', endpoints: endpoints, data: dev.getIeeeAddr() });
    });

    this.on('ind:interview', function (dev, status) {
        self.emit('ind', { type: 'devInterview', status: status, data: dev });
    });

    this.on('ind:leaving', function (epList, nwkAddr, ieeeAddr) {
        self.emit('ind', { type: 'devLeaving', endpoints: epList, data: ieeeAddr });
    });

    this.on('ind:changed', function (ep, notifData) {
        self.emit('ind', { type: 'devChange', endpoints: [ ep ], data: notifData });
    });

    this.on('ind:dataConfirm', function (ep, notifData) {
        self.emit('ind', { type: 'dataConfirm', endpoints: [ ep ], data: notifData });
    });

    this.on('ind:statusChange', function (ep, cId, payload, msg) {
        var cIdString = zclId.cluster(cId),
            notifData = Object.assign({}, payload);

        cIdString = cIdString ? cIdString.key : cId;
        notifData.cid = cIdString;

        self.emit('ind', { type: 'statusChange', endpoints: [ ep ], data: notifData, msg: msg });
    });

    this.on('ind:reported', function (ep, cId, attrs) {
        var cIdString = zclId.cluster(cId),
            notifData = {
                cid: '',
                data: {}
            };

        self._updateFinalizer(ep, cId, attrs, true);

        cIdString = cIdString ? cIdString.key : cId;
        notifData.cid = cIdString;

        _.forEach(attrs, function (rec) {  // { attrId, dataType, attrData }
            var attrIdString = zclId.attr(cIdString, rec.attrId);
            attrIdString = attrIdString ? attrIdString.key : rec.attrId;

            notifData.data[attrIdString] = rec.attrData;
        });

        self.emit('ind', { type: 'attReport', endpoints: [ ep ], data: notifData });
    });

    this.on('ind:status', function (dev, status) {
        var endpoints = [];

        _.forEach(dev.epList, function (epId) {
            endpoints.push(dev.getEndpoint(epId));
        });

        self.emit('ind', { type: 'devStatus', endpoints: endpoints, data: status });
    });
}

util.inherits(ZShepherd, EventEmitter);

/*************************************************************************************************/
/*** Public Methods                                                                            ***/
/*************************************************************************************************/
ZShepherd.prototype.start = function (generateEvent = true) {
    var self = this;

    debug.shepherd("starting")

    return init.setupShepherd(this).then(function () {
        self._enabled = true;   // shepherd is enabled
        self.emit('_ready', generateEvent);    // if all done, shepherd fires '_ready' event for inner use
        debug.shepherd("ready & enabled")
    })
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
    var self = this,
        devbox = this._devbox,
        removeDevs = [];

    proving.stringOrNumber(mode, 'mode should be a number or a string.');

    if (mode === 'hard' || mode === 0) {
        // clear database
        if (self._devbox) {
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

ZShepherd.prototype.mount = function (zApp) {
    var self = this,
        deferred = (callback && Q.isPromise(callback.promise)) ? callback : Q.defer(),
        coord = this.controller.getCoord(),
        mountId,
        loEp;

    if (zApp.constructor.name !== 'Zive')
        throw new TypeError('zApp should be an instance of Zive class.');

    if (this._mounting) {
        this._mountQueue.push(function () {
            self.mount(zApp, deferred);
        });
        return deferred.promise
    }

    this._mounting = true;

    Q.fcall(function () {
        _.forEach(self._zApp, function (app) {
            if (app === zApp)
                throw new  Error('zApp already exists.');
        });
        self._zApp.push(zApp);
    }).then(function () {
        if (coord) {
            mountId = Math.max.apply(null, coord.epList);
            zApp._simpleDesc.epId = mountId > 10 ? mountId + 1 : 11;  // epId 1-10 are reserved for delegator
            loEp = new Coordpoint(coord, zApp._simpleDesc);
            loEp.clusters = zApp.clusters;
            coord.endpoints[loEp.getEpId()] = loEp;
            zApp._endpoint = loEp;
        } else {
            throw new Error('Coordinator has not been initialized yet.');
        }
    }).then(function () {
        return self.controller.registerEp(loEp).then(function () {
            debug.shepherd('Register zApp, epId: %s, profId: %s ', loEp.getEpId(), loEp.getProfId());
        });
    }).then(function () {
        return self.controller.querie.coordInfo().then(function (coordInfo) {
            coord.update(coordInfo);
            return Q.ninvoke(self._devbox, 'sync', coord._getId());
        });
    }).then(function () {
        self._attachZclMethods(loEp);
        self._attachZclMethods(zApp);

        loEp.onZclFoundation = function (msg, remoteEp) {
            return zApp.foundationHandler(msg, remoteEp);
        };
        loEp.onZclFunctional = function (msg, remoteEp) {
            return zApp.functionalHandler(msg, remoteEp);
        };

        deferred.resolve(loEp.getEpId());
    }).catch(function (err) {
        deferred.reject(err);
    }).then(function () {
        self._mounting = false;
        if (self._mountQueue.length)
            process.nextTick(function () {
                self._mountQueue.shift()();
            });
    });

    if (!(callback && Q.isPromise(callback.promise)))
        return deferred.promise
};

ZShepherd.prototype.list = function (ieeeAddrs, showIncomplete = false) {
    var self = this,
        foundDevs;

    if (_.isString(ieeeAddrs))
        ieeeAddrs = [ ieeeAddrs ];
    else if (!_.isUndefined(ieeeAddrs) && !_.isArray(ieeeAddrs))
        throw new TypeError('ieeeAddrs should be a string or an array of strings if given.');
    else if (!ieeeAddrs)
        ieeeAddrs = _.map(this._devbox.exportAllObjs().filter(function(a){return showIncomplete || !a.incomplete}), function (dev) {
            return dev.getIeeeAddr();  // list all
        });

    foundDevs = _.map(ieeeAddrs, function (ieeeAddr) {
        proving.string(ieeeAddr, 'ieeeAddr should be a string.');

        var devInfo,
            found = self._findDevByAddr(ieeeAddr);

        if (found)
            devInfo = _.omit(found.dump(), [ 'id', 'endpoints' ]);

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

ZShepherd.prototype.lqiScan = function (startAddr, emit) {
	var info = this.info();
	var self = this;
    const noDuplicate = {};

    const processResponse = function(parent){
        return function(data){
            var set = {}
            for(let i=0;i<data.length;i++){
                const ieeeAddr = data[i].ieeeAddr;
                if(ieeeAddr == "0x0000000000000000") continue
    
                let dev = self._findDevByAddr(ieeeAddr);
                data[i].parent = parent
                data[i].status = dev ? dev.status : "offline";
                if(emit) emit(data[i])
                
                if(!noDuplicate[ieeeAddr]){
                    noDuplicate[ieeeAddr] = data[i]
                    if(dev && dev.type == "Router") {
                        set[ieeeAddr] = self.lqi(ieeeAddr).catch(function(err){
                            noDuplicate[ieeeAddr].error = err
                            return [];
                        })
                    }
                }
            }

            var setValues = Object.values(set)
            if(!setValues.length) return

            /* Breadth first */
            return Q.all(setValues).then(function(){
                for(let ieeeAddr in set){
                    set[ieeeAddr] = set[ieeeAddr].then(processResponse(ieeeAddr))
                }
                return Q.all(Object.values(set))
            })
        }
    }

    if(!startAddr){
        startAddr = info.net.ieeeAddr
    }

    noDuplicate[startAddr] = {
        status: "online",
        ieeeAddr: startAddr,
        type: "Coordinator"
    }

    return this.lqi(startAddr)
        .then(processResponse(startAddr))
        .then(function(){
            return Object.values(noDuplicate)
        })
}

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

    oldDev = _.isNil(dev._getId()) ? undefined : devbox.get(dev._getId());

    if (oldDev) throw new Error('dev exists, unregister it first.')

    if (dev._recovered) {
        id = await Q.ninvoke(devbox, 'set', dev._getId(), dev)
        dev._recovered = false;
        delete dev._recovered;
    } else {
        dev.update({ joinTime: Math.floor(Date.now()/1000) });
        id = await Q.ninvoke(devbox, 'add', dev)
        dev._setId(id);
    }
    return id;
};

ZShepherd.prototype.clearDev = function (dev) {
    return Q.ninvoke(this._devbox, 'remove', dev)
};

ZShepherd.prototype._unregisterDev = function (dev) {
    return this.clearDev(dev._getId());
};

ZShepherd.prototype._attachZclMethods = function (ep) {
    var self = this;

    if (ep.constructor.name === 'Zive') {
        var zApp = ep;
        zApp.foundation = function (dstAddr, dstEpId, cId, cmd, zclData, cfg) {
            var dstEp = self.find(dstAddr, dstEpId);

            if (!dstEp)
                throw new Error('dstEp is not found.')
                
            return self._foundation(zApp._endpoint, dstEp, cId, cmd, zclData, cfg);
        };

        zApp.functional = function (dstAddr, dstEpId, cId, cmd, zclData, cfg) {
            var dstEp = self.find(dstAddr, dstEpId);

            if (!dstEp)
                throw new Error('dstEp is not found.')
            
            return self._functional(zApp._endpoint, dstEp, cId, cmd, zclData, cfg);
        };
    } else {
        ep.foundation = function (cId, cmd, zclData, cfg) {
            return self._foundation(ep, ep, cId, cmd, zclData, cfg);
        };
        ep.functional = function (cId, cmd, zclData, cfg) {
            return self._functional(ep, ep, cId, cmd, zclData, cfg);
        };
        ep.bind = function (cId, dstEpOrGrpId) {
            return self.controller.bind(ep, cId, dstEpOrGrpId);
        };
        ep.unbind = function (cId, dstEpOrGrpId) {
            return self.controller.unbind(ep, cId, dstEpOrGrpId);
        };
        ep.read = async function (cId, attrId) {
            var attr = zclId.attr(cId, attrId);

            attr = attr ? attr.value : attrId;

            const readStatusRecsRsp = await self._foundation(ep, ep, cId, 'read', [{ attrId: attr }])
            var rec = readStatusRecsRsp[0];

            if (rec.status !== 0) throw new Error('request unsuccess: ' + rec.status);
            return rec.attrData;
                
        };
        ep.write = async function (cId, attrId, data) {
            var attr = zclId.attr(cId, attrId),
                attrType = zclId.attrType(cId, attrId).value;

            const writeStatusRecsRsp = await self._foundation(ep, ep, cId, 'write', [{ attrId: attr.value, dataType: attrType, attrData: data }])
            var rec = writeStatusRecsRsp[0];

            if (rec.status === 0)
                return data;
            else
                throw new Error('request unsuccess: ' + rec.status)
        };
        ep.report = async function (cId, attrId, minInt, maxInt, repChange) {
            let coord = self.controller.getCoord(),
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

    const msg = await this.af.zclFoundation(srcEp, dstEp, cId, cmd, zclData, cfg)
    var cmdString = zclId.foundation(cmd);
    cmdString = cmdString ? cmdString.key : cmd;

    if (cmdString === 'read')
        this._updateFinalizer(dstEp, cId, msg.payload);
    else if (cmdString === 'write' || cmdString === 'writeUndiv' || cmdString === 'writeNoRsp')
        this._updateFinalizer(dstEp, cId);

    return msg.payload;
        
};

ZShepherd.prototype._functional = async function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    cfg = cfg || {};

    const msg = await this.af.zclFunctional(srcEp, dstEp, cId, cmd, zclData, cfg)
    if(cfg.skipFinalize === false){
        this._updateFinalizer(dstEp, cId);
    }
    return msg.payload
};

ZShepherd.prototype._updateFinalizer = function (ep, cId, attrs, reported) {
    var self = this,
        cIdString = zclId.cluster(cId),
        clusters = ep.getClusters().dumpSync();

    cIdString = cIdString ? cIdString.key : cId;

    Q.fcall(function () {
        if (attrs) {
            var newAttrs = {};

            _.forEach(attrs, function (rec) {  // { attrId, status, dataType, attrData }
                var attrIdString = zclId.attr(cId, rec.attrId);
                attrIdString = attrIdString ? attrIdString.key : rec.attrId;

                if (reported)
                    newAttrs[attrIdString] = rec.attrData;
                else
                    newAttrs[attrIdString] = (rec.status === 0) ? rec.attrData : null;
            });

            return newAttrs;
        } else {
            return self.af.zclClusterAttrsReq(ep, cId);
        }
    }).then(function (newAttrs) {
        var oldAttrs = clusters[cIdString].attrs,
            diff = zutils.objectDiff(oldAttrs, newAttrs);

        if (!_.isEmpty(diff)) {
            _.forEach(diff, function (val, attrId) {
                ep.getClusters().set(cIdString, 'attrs', attrId, val);
            });

            self.emit('ind:changed', ep, { cid: cIdString, data: diff });
        }
    }).catch(function () {
        return;
    });
};

module.exports = ZShepherd;
