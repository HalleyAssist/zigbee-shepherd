/* jshint node: true */
'use strict';

var EventEmitter = require('events');

var Q = require('q'),
    _ = require('busyman'),
    CCZnp = require('cc-znp'),
    proving = require('proving'),
    common = require('zstack-common'),
    debug = {
        shepherd: require('debug')('zigbee-shepherd'),
        init: require('debug')('zigbee-shepherd:init'),
        request: require('debug')('zigbee-shepherd:request'),
        response: require('debug')('zigbee-shepherd:response')
    },
    Ziee = require('ziee'),
    {AfController} = require('zstack-af')

var Zdo = require('./zdo'),
    querie = require('./querie'),
    bridge = require('./event_bridge.js'),
    ZSC = common.constants,
    init = require('../initializers/init_controller'),
    nvParams = require('../config/nv_start_options.js');

var Device = require('../model/device'),
    Endpoint = require('../model/endpoint'),
    Coordpoint = require('../model/coordpoint');

class Controller extends AfController {
    constructor(shepherd, cfg) {
        super()

        /***************************************************/
        /*** Protected Members                           ***/
        /***************************************************/
        this._shepherd = shepherd;
        this._coord = null;
        this._znp = new CCZnp(cfg);
        this._zdo = new Zdo(this);
        this._resetting = false;
        this._joinLocks = {};
        this._permitJoinTime = 0;
        this._permitJoinInterval;

        this._net = {
            state: null,
            channel: null,
            panId: null,
            extPanId: null,
            ieeeAddr: null,
            nwkAddr: null,
            joinTimeLeft: 0
        };

        this._firmware = {
            version: null,
            revision: null
        };
        
        this._joinWaitList = {}
        this._rebornDevs = {}

        /***************************************************/
        /*** Public Members                              ***/
        /***************************************************/
        this.querie = querie(this);

        /***************************************************/
        /*** Event Handlers                              ***/
        /***************************************************/

        this._znp.on('AREQ', (msg) => {
            bridge.areqEventBridge(this, msg);
        });

        this.on('ZDO:tcDeviceInd', (tcData) => {
            if(!tcData.parentaddr || !tcData.nwkaddr){
                return
            }
            const data = {srcaddr: tcData.nwkaddr, nwkaddr: tcData.nwkaddr, ieeeaddr: tcData.extaddr};
            this.joinHandler(data, true);
        });

        this.on('ZDO:endDeviceAnnceInd', (data) => {
            this.joinHandler(data, true);
        });


        this.on('ZDO:ieeeRsp', (data) => {
            // data: { status: 0, ieeeaddr, nwkaddr }
            if(!data.nwkaddr || this._joinWaitList[data.nwkaddr]){
                return
            }

            /* If there is no join request within 3s we will attempt a different method of joining */
            this._joinWaitList[data.nwkaddr] = setTimeout(function(){
                this.endDeviceAnnceHdlr(data);
            }, 3000);
        });

        /* on device leave abort long requests */
        this.on("ZDO:leaveInd", (msg)=>{
            var nwkAddr = msg.srcaddr
            this._zdo.emit(nwkAddr.toString())

            if(this._joinWaitList[nwkAddr]){
                clearTimeout(this._joinWaitList[nwkAddr])
                delete this._joinWaitList[nwkAddr]
            }

            if(this._joinLocks[msg.extaddr]){
                var joins = this._joinLocks[msg.extaddr].queue
                for(var i=0;i<joins.length;i++){
                    var entry = joins[i]
                    if(entry.nwkAddr == msg.nwkaddr){
                        entry.aborted(true)
                        joins.splice(i,1)
                        i--
                    }
                }
            }
        })
    }
    permitJoinCountdown() {
        return this._permitJoinTime -= 1;
    }
    isResetting () {
        return this._resetting;
    }
    limitConcurrency (fcall){
        return fcall
    }

    /*************************************************************************************************/
    /*** Public ZigBee Utility APIs                                                                ***/
    /*************************************************************************************************/
    getShepherd () {
        return this._shepherd;
    }

    getCoord () {
        return this._coord;
    }

    getFirmwareInfo () {
        return _.cloneDeep(this._firmware);
    }

    getNetInfo () {
        const net = _.cloneDeep(this._net);

        if (net.state === ZSC.ZDO.devStates.ZB_COORD)
            net.state = 'Coordinator';

        net.joinTimeLeft = this._permitJoinTime;

        return net;
    }

    setNetInfo (netInfo) {
        _.forEach(netInfo, (val, key) => {
            if (_.has(this._net, key))
                this._net[key] = val;
        });
    }

    setFirmware (firmwareInfo) {
        this._firmware = firmwareInfo
    }

    /*************************************************************************************************/
    /*** Mandatory Public APIs                                                                     ***/
    /*************************************************************************************************/
    async start () {
        await this._znp.start()
        await init.setupCoord(this)
    }

    async close () {
        await this._znp.close()
    }

    async reset (mode) {
        var deferred = Q.defer(),
            startupOption = nvParams.startupOption.value[0];

        proving.stringOrNumber(mode, 'mode should be a number or a string.');

        this.once('_reset', err => {
            return err ? deferred.reject(err) : deferred.resolve();
        });

        if(mode !== 'hard' && mode !== 0) return
        if(this._nvChanged && startupOption !== 0x02) {
            //nvParams.startupOption.value[0] = 0x02


            const steps = [
                ['SYS', 'osalNvWrite', nvParams.startupOption],//Possibly not 3.x.x?
                ['SYS', 'osalNvWrite', nvParams.panId],
                ['SYS', 'osalNvWrite', nvParams.extPanId],
                ['SYS', 'osalNvWrite', nvParams.channelList],
                ['SYS', 'osalNvWrite', nvParams.logicalType],
                ['SYS', 'osalNvWrite', nvParams.precfgkey],
                ['SYS', 'osalNvWrite', nvParams.precfgkeysEnable],
                ['SYS', 'osalNvWrite', nvParams.zdoDirectCb]
            ]
            for(const args of steps){
                await this.request(...args)
            }
            await Q(this.request('SYS', 'osalNvItemInit', nvParams.znpCfgItem)).delay(10).catch(function (err) {
                return (err.message === 'rsp error: 9') ? null : Q.reject(err);  // Success, item created and initialized
            })
            await this.request('SYS', 'osalNvWrite', nvParams.znpHasConfigured)

            
            const channelMask = nvParams.channelList.value
            const channelInt = channelMask[0] + (channelMask[1] << 8) + (channelMask[2] << 16) + (channelMask[3] << 24)
            await this.request('APP_CFG', 'bdbSetChannel', {isPrimary: 0x1, channel: channelInt});
            await this.request('APP_CFG', 'bdbSetChannel', {isPrimary: 0x0, channel: 0x0});
            await this.request('SYS', 'osalNvWrite', {
                id: 0x55,    // 0x2D
                offset: 0,
                len: 0x01,
                value: [ 0x00 ]
            })//BDB_NODE_IS_ON_A_NETWORK
        }
        if (mode === 'soft' || mode === 1) {
            debug.shepherd('Starting a software reset...');
            this._resetting = 'soft';
        } else if (mode === 'hard' || mode === 0) {
            debug.shepherd('Starting a hardware reset...');
            this._resetting = 'hard';
        } else {
            throw new Error('Unknown reset mode.');
        }

        const delay = deferred.promise.timeout(1000)

        await this.request('SYS', 'resetReq', { type: 0x01 })

        await delay
        
        this._resetting = false;
        if (this._nvChanged) {
            nvParams.startupOption.value[0] = startupOption;
            this._nvChanged = false;
        }
    }

    async request (subsys, cmdId, valObj) {
        proving.stringOrNumber(subsys, 'subsys should be a number or a string.');
        proving.stringOrNumber(cmdId, 'cmdId should be a number or a string.');

        if (!_.isPlainObject(valObj) && !_.isArray(valObj))
            throw new TypeError('valObj should be an object or an array.');

        if (_.isString(subsys))
            subsys = subsys.toUpperCase();

        let rsp
        if (subsys === 'ZDO' || subsys === 5)
            rsp = await this._zdo.request(cmdId, valObj);          // use wrapped zdo as the exported api
        else 
            rsp = await this._znp.request(subsys, cmdId, valObj)

        if ((subsys !== 'ZDO' && subsys !== 5) && rsp && rsp.hasOwnProperty('status') && rsp.status !== 0){
            throw new Error('rsp error: ' + rsp.status)
        }
        
        return rsp
    }

    async permitJoin (time, type) {
        // time: seconds, 0x00 disable, 0xFF always enable
        // type: 0 (coord) / 1 (all)

        proving.number(time, 'time should be a number.');
        proving.stringOrNumber(type, 'type should be a number or a string.');

        let addrmode,
            dstaddr;
        if (type === 'coord') {
            addrmode = 0x02;
            dstaddr = 0x0000;
        } else if (type === 'all') {
            addrmode = 0x0F;
            dstaddr = 0xFFFC;   // all coord and routers
        } else if (typeof type === "number") {
            addrmode = 0x02;
            dstaddr = type;//Specific Network address
        } else {
            throw new Error('Not a valid type.')
        }

        if (time > 255 || time < 0)
            throw new Error('Jointime can only range from  0 to 255.')

        this._permitJoinTime = Math.floor(time);

        const rsp = await this.request('ZDO', 'mgmtPermitJoinReq', { addrmode: addrmode, dstaddr: dstaddr , duration: time, tcsignificance: 0 });

        this.emit('permitJoining', this._permitJoinTime);

        if (time !== 0 && time !== 255) {
            clearInterval(this._permitJoinInterval);
            this._permitJoinInterval = setInterval(() => {
                if (this.permitJoinCountdown() === 0)
                    clearInterval(this._permitJoinInterval);
                this.emit('permitJoining', this._permitJoinTime);
            }, 1000);
        }
        return rsp;
    }

    async remove (dev, cfg) {
        // cfg: { reJoin, rmChildren }
        let reqArgObj,
            rmChildren_reJoin = 0x00;

        if (!(dev instanceof Device))
            throw new TypeError('dev should be an instance of Device class.');
        else if (!_.isPlainObject(cfg))
            throw new TypeError('cfg should be an object.');
        else if (!dev.getNwkAddr())
            throw new TypeError('dev has invalid nwk address');

        cfg.reJoin = cfg.hasOwnProperty('reJoin') ? !!cfg.reJoin : true;               // defaults to true
        cfg.rmChildren = cfg.hasOwnProperty('rmChildren') ? !!cfg.rmChildren : false;  // defaults to false

        rmChildren_reJoin = cfg.reJoin ? (rmChildren_reJoin | 0x01) : rmChildren_reJoin;
        rmChildren_reJoin = cfg.rmChildren ? (rmChildren_reJoin | 0x02) : rmChildren_reJoin;

        reqArgObj = {
            dstaddr: cfg.nwkAddr === undefined ? dev.getNwkAddr() : 0,
            deviceaddress: dev.getIeeeAddr(),
            removechildren_rejoin: rmChildren_reJoin
        };

        return await this.request('ZDO', 'mgmtLeaveReq', reqArgObj)
    }

    async registerEp (loEp) {
        if (!(loEp instanceof Coordpoint))
            throw new TypeError('loEp should be an instance of Coordpoint class.');

        try {
            return await this.request('AF', 'register', makeRegParams(loEp))
        } catch(err){
            if(err.message === 'rsp error: 184') return await this.reRegisterEp(loEp)
            throw err
        }
    }

    async deregisterEp (loEp) {
        var coordEps = this.getCoord().endpoints;

        if (!(loEp instanceof Coordpoint))
            throw new TypeError('loEp should be an instance of Coordpoint class.');

        const rsp = await this.request('AF', 'delete', { endpoint: loEp.getEpId() });
        delete coordEps[loEp.getEpId()];
        return rsp
    }

    async reRegisterEp (loEp) {
        await this.deregisterEp(loEp)
        return await this.request('AF', 'register', makeRegParams(loEp));
    }

    simpleDescReq (nwkAddr, ieeeAddr) {
        return this.querie.deviceWithEndpoints(nwkAddr, ieeeAddr);
    }

    bind (srcEp, cId, dstEpOrGrpId) {
        return this.querie.setBindingEntry('bind', srcEp, cId, dstEpOrGrpId);
    }

    unbind (srcEp, cId, dstEpOrGrpId) {
        return this.querie.setBindingEntry('unbind', srcEp, cId, dstEpOrGrpId);
    }

    findEndpoint (addr, epId) {
        return this._shepherd.find(addr, epId);
    }

    setNvParams (net) {
        // net: { panId, channelList, precfgkey, precfgkeysEnable, startoptClearState }
        net = net || {};
        proving.object(net, 'opts.net should be an object.');

        _.forEach(net, function (val, param) {
            switch (param) {
                case 'panId':
                    proving.number(val, 'net.panId should be a number.');
                    nvParams.panId.value = [ val & 0xFF, (val >> 8) & 0xFF ];
                    break;
                case 'precfgkey':
                    if (!_.isArray(val) || val.length !== 16)
                        throw new TypeError('net.precfgkey should be an array with 16 uint8 integers.');
                    nvParams.precfgkey.value = val;
                    break;
                case 'precfgkeysEnable':
                    proving.boolean(val, 'net.precfgkeysEnable should be a bool.');
                    nvParams.precfgkeysEnable.value = val ? [ 0x01 ] : [ 0x00 ];
                    break;
                case 'startoptClearState':
                    proving.boolean(val, 'net.startoptClearState should be a bool.');
                    nvParams.startupOption.value = val ? [ 0x02 ] : [ 0x00 ];
                    break;
                case 'channelList':
                    proving.array(val, 'net.channelList should be an array.');
                    var chList = 0;

                    _.forEach(val, function (ch) {
                        if (ch >= 11 && ch <= 26)
                            chList = chList | ZSC.ZDO.channelMask['CH' + ch];
                    });

                    nvParams.channelList.value = [ chList & 0xFF, (chList >> 8) & 0xFF, (chList >> 16) & 0xFF, (chList >> 24) & 0xFF ];
                    break;
                default:
                    throw new TypeError('Unkown argument: ' + param + '.');
            }
        });
    }

    async checkNvParams () {
        function bufToArray(buf) {
            var arr = [];

            for (var i = 0; i < buf.length; i += 1) {
                arr.push(buf.readUInt8(i));
            }

            return arr;
        }

        const steps = [
            ['znpHasConfigured', 'SYS', 'osalNvRead', nvParams.znpHasConfigured],
            ['panId', 'SYS', 'osalNvRead', nvParams.panId],
            ['channelList', 'SYS', 'osalNvRead', nvParams.channelList],
            ['precfgkey', 'SYS', 'osalNvRead', nvParams.precfgkey],
            ['precfgkeysEnable', 'SYS', 'osalNvRead', nvParams.precfgkeysEnable]
        ]
        try {
            for(const step of steps){
                const [key, ...args] = step
                const rsp = await this.request(...args)
                if (!_.isEqual(bufToArray(rsp.value), nvParams[key].value)) throw new Error(`reset ${key}`)
            }
        } catch(ex){
            let err = ex
            if(err.message !== undefined){
                err = err.message
            }
            if (err.substr(0,5) === 'reset' || err === 'rsp error: 2') {
                this._nvChanged = true;
                debug.init('Non-Volatile memory is changed ('+err+').');
                return await this.reset('hard');
            } 
            throw ex
        }
    }

    async checkOnline (dev) {
        var nwkAddr = dev.getNwkAddr(),
            ieeeAddr = dev.getIeeeAddr();

        if(typeof nwkAddr == "undefined") return null;

        try {
            await Q(this.request('ZDO', 'nodeDescReq', { dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr })).timeout(5000)
        } catch(err){
            return
        }
        if (dev.status === 'offline' && nwkAddr){
            this.emit('ZDO:endDeviceAnnceInd', { srcaddr: nwkAddr, nwkaddr: nwkAddr, ieeeaddr: ieeeAddr });
        }
    }

    _afDispatch(af, type, msg){
        let targetEp, remoteEp
        let coord = this.getCoord()
            
        if (msg.hasOwnProperty('endpoint')) {                                               // dataConfirm, reflectError
            if(!coord) {
                debug.shepherd("skipping message as coord not initialized")
                return
            }
            targetEp = coord.getEndpoint(msg.endpoint);                  //  => find local ep, such a message is going to local ep
        } else if (msg.hasOwnProperty('srcaddr') && msg.hasOwnProperty('srcendpoint')) {    // incomingMsg, incomingMsgExt, zclIncomingMsg
            if(!coord) {
                debug.shepherd("skipping message as coord not initialized")
                return
            }
            targetEp = coord.getEndpoint(msg.dstendpoint);               //  => find local ep

            if (targetEp) {  // local
                remoteEp = this.findEndpoint(msg.srcaddr, msg.srcendpoint);

                if (targetEp.isDelegator()) {  // delegator, pass message to remote endpoint
                    targetEp = remoteEp;
                } else if (!remoteEp) {        // local zApp not found, get ieeeaddr and emit fake 'endDeviceAnnceInd' msg
                    var msgBuffer = this._rebornDevs[msg.srcaddr];

                    if (Array.isArray(msgBuffer)) {
                        msgBuffer.push({ type: type, msg: msg });
                    } else if (msgBuffer === undefined) {
                        msgBuffer = this._rebornDevs[msg.srcaddr] = [ { type: type, msg: msg } ];

                        this.request('ZDO', 'ieeeAddrReq', { shortaddr: msg.srcaddr, reqtype: 0, startindex:0 }).then((rsp) => {
                            // rsp: { status, ieeeaddr, nwkaddr, startindex, numassocdev, assocdevlist }
                            this.once('ind:incoming:' + rsp.ieeeaddr, () => {
                                if (this.findEndpoint(msg.srcaddr, msg.srcendpoint) && Array.isArray(msgBuffer))
                                    for(const item of msgBuffer) {
                                        dispatchIncomingMsg(item.type, item.msg);
                                    }
                                else
                                    delete this._rebornDevs[msg.srcaddr];
                            });
                            this.emit('ZDO:endDeviceAnnceInd', { srcaddr: rsp.nwkaddr, nwkaddr: rsp.nwkaddr, ieeeaddr: rsp.ieeeaddr });
                        }).catch(function (err) {
                            delete this._rebornDevs[msg.srcaddr];
                        });
                    }

                    return;
                }
            }
        }

        if (!targetEp)      // if target not found, ignore this message
            return;

        return af.dispatchIncomingMsg(targetEp, remoteEp, type, msg)
    }

    deviceWithEndpoints (ieeeAddr, epList, nwkAddr) {
        var epQueries = []

        for(var i=0;i<epList.length;i++) {
            var epQuery = this.querie.endpoint(ieeeAddr, nwkAddr, epList[i]);
            epQueries.push(epQuery);
        }

        return Q.all(epQueries);
    }

    async joinHandler (data, abortExisting) {
        if(data.ieeeaddr == "0xffffffffffffffff" || data.ieeeaddr == "0x0000000000000000"){
            debug.shepherd("Received likely incorrect IEEE from faulty device '%s'. We will ignore.", data.ieeeaddr)
            return true
        }

        var ret = Q.defer()

        // Join locking
        let joinLock = this._joinLocks[data.ieeeaddr]
        if(!joinLock){
            joinLock = this._joinLocks[data.ieeeaddr] = {queue: []}
        }
        if(this._joinWaitList[data.ieeeaddr]){
            clearTimeout(this._joinWaitList[data.ieeeaddr]);
            delete this._joinWaitList[data.ieeeaddr];
        }


        /* If we are certain this is the join we care about then clear existing */
        if(abortExisting){
            var abortedAddrs = []
            for(var i=0;i<joinLock.queue.length;i++){
                var entry = joinLock.queue[i]
                if(entry.ieeeAddr == data.ieeeaddr && entry.nwkAddr != data.nwkaddr){
                    entry.aborted(true)
                    joinLock.queue.splice(i,1)
                    i--
                    abortedAddrs.push(data.nwkaddr)
                }
            }
            for(var i=0;i<abortedAddrs.length;i++){
                this._zdo.emit(abortedAddrs[i].toString())
            }
            if(abortedAddrs.length) {
                debug.shepherd("** Aborted %d prior joins for %s (0x%s)", abortedAddrs.length, data.ieeeaddr, data.nwkaddr.toString(16))
            }
        }
    
        /* abort once, return forever else false */
        let _abort = false
        const joinEntry = {
            ieeeAddr: data.ieeeaddr, 
            nwkAddr: data.nwkaddr,
            fn: async () => {
                debug.shepherd("** Joining %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
                try {
                    const r = await this._endDeviceAnnceHdlr(data, joinEntry.aborted);
                    ret.resolve(r)
                } catch(err){
                    ret.reject(err)
                    this.getShepherd().emit('error', 'Device ' + data.ieeeaddr + " failed the joining process due to: " + err.message);
                }

                /* Remove current */
                var index = joinLock.queue.indexOf(joinEntry);
                if (index > -1) {
                    joinLock.queue.splice(index, 1);
                }

                debug.shepherd("** Done %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))

                /* Execute latest */
                if(joinLock.queue.length){
                    Q.fcall(joinLock.queue[joinLock.queue.length - 1].fn)
                }
            },
            aborted: function(abort){
                if(abort){
                    _abort = abort
                }
                return _abort
            }
        }

        joinLock.queue.push(joinEntry)
        if(joinLock.queue.length == 1){
            await joinLock.queue[0].fn()
        }

        return await ret.promise;
    }

    async _queryBasic(dev, aborted){
        const devInfo = await retry(async () => {
            if(aborted()) throw new Error("__abort__")
            return await this.simpleDescReq(dev.nwkAddr, dev.ieeeAddr) // concurrency limited by querie functions
        }, 2)

        if(aborted()) throw new Error("__abort__")
        if(devInfo.capabilities) dev.capabilities = devInfo.capabilities;

        /* Construct endpoints */
        const endpoints = {}
        for(const i in devInfo.endpoints){
            let ep = new Endpoint(dev, devInfo.endpoints[i]);
            ep.clusters = new Ziee();
            this._shepherd._attachZclMethods(ep);
            endpoints[ep.getEpId()] = ep;
        }
        devInfo.endpoints = endpoints

        await dev.update(devInfo)

        if(aborted()) throw new Error("__abort__")
        const attrMap = {
            4: 'manufName',
            5: 'modelId',
            7: 'powerSource'
        };

        const powerSourceMap = {
            0: 'Unknown',
            1: 'Mains (single phase)',
            2: 'Mains (3 phase)',
            3: 'Battery',
            4: 'DC Source',
            5: 'Emergency mains constantly powered',
            6: 'Emergency mains and transfer switch'
        };

        // Loop all endpoints to find genBasic cluster, and get basic endpoint if possible
        let basicEpInst;
        for (const i in dev.endpoints) {
            const ep = dev.getEndpoint(i),
                  clusterList = ep.getClusterList();

            if (Array.isArray(clusterList) && clusterList.indexOf(0) > -1) {
                // genBasic found
                basicEpInst = ep;
                break;
            }
        }

        if (!basicEpInst || basicEpInst instanceof Error) return dev;

        // Get manufName, modelId and powerSource information
        let readStatusRecsRsp
        try {
            readStatusRecsRsp = await retry(() => { 
                if(aborted()) throw new Error("__abort__")
                return this.limitConcurrency(() =>
                    this._shepherd.af.zclFoundation(this.getCoord().getDelegator(), basicEpInst, 0, 'read', [{ attrId: 4 }, { attrId: 5 }, { attrId: 7 }])
                )()
            }, 3)
        } catch(err){
            throw new Error("Unable to query manditory cluster genBasic, error: " + err);
        }
        
        let data = {};
        if (readStatusRecsRsp && Array.isArray(readStatusRecsRsp.payload)) {
            for(const item of readStatusRecsRsp.payload){
                // item { attrId, status, dataType, attrData }
                if (item && item.attrData) {
                    if (item.attrId === 7)
                        data[attrMap[item.attrId]] = powerSourceMap[item.attrData];
                    else
                        data[attrMap[item.attrId]] = item.attrData;
                }
            }
        }

        return data
    }

    async _fullInterview(dev, aborted, interested){
        const interviewEvents = new EventEmitter();
        const endpoints = dev.getEndpointList()
        interviewEvents.on('ind:interview', status => {
            if (status && status.endpoint) status.endpoint.total = endpoints.length;
            this._shepherd.emit('ind:interview', dev.ieeeAddr, status);
        });

        debug.shepherd('Device: %s starting interview for %d endpoints with interest in %s.', dev.getIeeeAddr(), endpoints.length, JSON.stringify(interested));
        for(const ep of endpoints) {
            if(aborted()) throw new Error("__abort__")
            const clusters = await this._shepherd.af.zclClustersReq(this.getCoord().getDelegator(), ep, interviewEvents, interested)
            if(aborted()) throw new Error("__abort__")
            for(const cId in clusters){
                const cInfo = clusters[cId]                    
                if(cInfo.dir) ep.clusters.init(cId, 'dir', { value: cInfo.dir });
                ep.clusters.init(cId, 'attrs', cInfo.attrs, false);
            }
        }
    }

    async _endDeviceAnnceHdlr (data, aborted) {
        var devbox = this._shepherd._devbox,
            joinTimeout,
            joinEvent = 'ind:incoming:' + data.ieeeaddr,
            dev = this._shepherd._findDevByAddr(data.ieeeaddr);

        if(dev && dev.status == "online") {
            if(dev.nwkAddr != data.nwkaddr){
                if(!dev.incomplete){
                    this._shepherd.emit('ind:incoming', dev);
                    this._shepherd.emit('ind:status', dev, 'online');
                    this.emit('ind:incoming:' + dev.getIeeeAddr());
                }
                dev.update({nwkAddr: data.nwkaddr})
                if(!dev.incomplete){
                    return
                }
            }else{
                return
            }
        }

        /* Join timeout notification & Join Queue */
        joinTimeout = setTimeout(() => {
            this.emit(joinEvent, '__timeout__');
            this._shepherd.emit('joining', { type: 'timeout', ieeeAddr: data.ieeeaddr });

            joinTimeout = null;
        }, 60000);
        this.once(joinEvent, () => {
            if (joinTimeout) {
                clearTimeout(joinTimeout);
                joinTimeout = null;
            }
        });

        /* Join is starting */
        debug.shepherd("** Associating %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
        this._shepherd.emit('joining', { type: 'associating', ieeeAddr: data.ieeeaddr, nwkAddr: data.nwkaddr }); 
        
        /* If this is a new device, create a new object */
        if(dev){
            dev.update({nwkAddr: data.nwkaddr})
        }else {
            dev = new Device({ieeeAddr: data.ieeeaddr, nwkAddr: data.nwkaddr});
            await this._shepherd._registerDev(dev)
        }

        let removed = false
        /* Fill out endoints */
        try {
            if(dev.incomplete) {
                debug.shepherd("** Identifying %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
                const basicData = await this._queryBasic(dev, aborted)

                // Update dev
                dev.update(basicData);

                debug.shepherd('Identified Device %s: { manufacturer: %s, product: %s }', dev.getIeeeAddr(), dev.manufName, dev.modelId);
            }
            
            /* Info Packet */
            const info = {
                ieeeAddr: dev.getIeeeAddr(),
                dev,
                endpoints: dev.getEndpointList()
            };

            /* Early Stage Accept */
            const interested = await Q(this._shepherd.acceptDevInterview(info)).timeout(6000)
            if(aborted()) throw new Error("__abort__")
            if(!interested) {
                debug.shepherd("Rejected during Interview")
                return /* rejection during interview */
            }
            
            /* Full Interview */
            debug.shepherd("** Interviewing %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
            if(dev.incomplete) {
                if(aborted()) throw new Error("__abort__")

                await this._fullInterview(dev, aborted, interested)
            }

            /* All the endpoints we will ever get */
            info.endpoints = dev.getEndpointList()
            if(!info.endpoints.length) {
                throw new Error('no eps')
            }
            
            /* Final Accept */
            debug.shepherd("** Accepting %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
            const result = await Q(this._shepherd.acceptDevIncoming(info)).timeout(6000)
            
            if(!result) {
                debug.shepherd("Rejected during final stage")
                await Q.ninvoke(devbox, 'remove', dev._id)
                removed = true
                return
            }
        
            if(aborted()) throw new Error("__abort__")

            /* Verdict */
            dev.update({ status: 'online', incomplete: false })
            
            debug.shepherd('Device %s joins the network.', dev.getIeeeAddr());

            this._shepherd.emit('ind:incoming', dev);
            this._shepherd.emit('ind:status', dev, 'online');
            this.emit('ind:incoming:' + dev.getIeeeAddr());

            return dev
        } catch (err) {
            /* Error Handling */
            if (err.stack) debug.shepherd(err.stack)
            this._shepherd.emit('error', 'Device ' + data.ieeeaddr + " failed to join due to error: " + err);
            this._shepherd.emit('joining', { type: 'error', ieeeAddr: data.ieeeaddr })
        } finally {
            if(!removed){
                try {
                    await Q.ninvoke(devbox, 'sync', dev._id)
                } catch(ex){
                    await Q.ninvoke(devbox, 'set', dev._id, dev)
                    await Q.ninvoke(devbox, 'sync', dev._id)
                }
            }

            this.emit(joinEvent, '__timeout__');
        }
    }

    _indirect_send (dstAddr, _send, promise){
        var sendTime, deferred = Q.defer()
        var self = this, afResendEvt = 'ZDO:networkStatus:' + dstAddr
        var ret, initialTime = Date.now()
        var eventArgs

        function setupEvent(){
            self.removeListener(...eventArgs)
            self.once(...eventArgs);
        }

        function handleResend(data){
            if(promise && promise.isPending && !promise.isPending()) {
                ret.isDone = true
                return
            }
            if(data.code != 6) {
                setupEvent()
            } else if((Date.now() - sendTime) > 6500){
                debug.shepherd("possible indirect expiration, resending (status: 0x%s)", data.code.toString(16))
                send();
            }else{
                setupEvent()
            }
        }
        eventArgs = [afResendEvt, handleResend]

        function handleTimeout(){   
            if(promise && promise.isPending && !promise.isPending()) {
                ret.isDone = true
                return false
            }
            if((Date.now() - initialTime) < self._shepherd.af.resendTimeout){
                debug.shepherd("possible indirect expiration due to timeout, resending")
                send()
                return true
            }
            return false
        }

        async function send(){
            sendTime = Date.now()
            setupEvent()
            var ret
            try {
                ret = await _send();
            }catch(ex){
                return deferred.reject(ex)
            }
            deferred.resolve(ret)
        }

        function done(){
            ret.isDone = true
            
            self.removeListener(...eventArgs)
        }

        send()

        ret = {evt: afResendEvt, result: deferred.promise, done: done, isDone: false, handleTimeout: handleTimeout}
        return ret
    }

    indirect_send (dstAddr, _send, promise){
        var ret = this._indirect_send(dstAddr, _send, promise)

        ret.result.finally(function(){
            ret.done()
        }).catch(function(){});

        return ret.result
    }
}

/*************************************************************************************************/
/*** Private Functions                                                                         ***/
/*************************************************************************************************/
function makeRegParams(loEp) {
    return {
        endpoint: loEp.getEpId(),
        appprofid: loEp.getProfId(),
        appdeviceid: loEp.getDevId(),
        appdevver: 0,
        latencyreq: ZSC.AF.networkLatencyReq.NO_LATENCY_REQS,
        appnuminclusters: loEp.inClusterList.length,
        appinclusterlist: loEp.inClusterList,
        appnumoutclusters: loEp.outClusterList.length,
        appoutclusterlist: loEp.outClusterList
    };
}

function retry(fn, n){
    var start = fn()
    for(var i=0;i<n;i++){
        start = start.catch(fn)
    }
    return start
}

module.exports = Controller;
