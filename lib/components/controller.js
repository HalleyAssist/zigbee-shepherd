/* jshint node: true */
'use strict';

var EventEmitter = require('eventemitter2');

var Q = require('q-lite'),
    _ = require('busyman'),
    CCZnp = require('cc-znp'),
    proving = require('proving'),
    debug = {
        shepherd: require('debug')('zigbee-shepherd'),
        init: require('debug')('zigbee-shepherd:init'),
        request: require('debug')('zigbee-shepherd:request'),
        response: require('debug')('zigbee-shepherd:response')
    },
    Ziee = require('ziee'),
    { AfController } = require('zstack-af')

var Zdo = require('./zdo'),
    querie = require('./querie'),
    bridge = require('./event_bridge.js'),
    ZSC = CCZnp.constants,
    init = require('../initializers/init_controller'),
    nvParams = require('../config/nv_start_options.js');

var Device = require('../model/device'),
    JoiningDevice = require('../model/JoiningDevice'),
    Endpoint = require('../model/endpoint'),
    Coordpoint = require('../model/coordpoint');


const MaxQueuedPackets = 8

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
            if (!tcData.parentaddr || !tcData.nwkaddr) {
                return
            }
            const data = { srcaddr: tcData.nwkaddr, nwkaddr: tcData.nwkaddr, ieeeaddr: tcData.extaddr };
            this.joinHandler(data, false);
        });

        this.on('ZDO:endDeviceAnnceInd', (data) => {
            this.joinHandler(data, true);
        });


        this.on('ZDO:ieeeRsp', (data) => {
            // data: { status: 0, ieeeaddr, nwkaddr }
            if (!data.nwkaddr || this._joinWaitList[data.nwkaddr]) {
                return
            }

            /* If there is no join request within 3s we will attempt a different method of joining */
            this._joinWaitList[data.nwkaddr] = setTimeout(function () {
                this.endDeviceAnnceHdlr(data);
            }, 3000);
        });

        /* on device leave abort long requests */
        this.on("ZDO:leaveInd", (msg) => {
            var nwkAddr = msg.srcaddr
            this._zdo.emit(nwkAddr.toString())

            if (this._joinWaitList[nwkAddr]) {
                clearTimeout(this._joinWaitList[nwkAddr])
                delete this._joinWaitList[nwkAddr]
            }

            if (this._joinLocks[msg.extaddr]) {
                var joins = this._joinLocks[msg.extaddr].queue
                for (var i = 0; i < joins.length; i++) {
                    var entry = joins[i]
                    if (entry.nwkAddr == msg.nwkaddr) {
                        entry.aborted(true)
                        joins.splice(i, 1)
                        i--
                    }
                }
            }
        })
    }
    permitJoinCountdown() {
        return this._permitJoinTime -= 1;
    }
    isResetting() {
        return this._resetting;
    }
    limitConcurrency(fcall) {
        return fcall
    }

    /*************************************************************************************************/
    /*** Public ZigBee Utility APIs                                                                ***/
    /*************************************************************************************************/
    getShepherd() {
        return this._shepherd;
    }

    getCoord() {
        return this._coord;
    }

    get znp(){
        return this._znp
    }

    getZnpInfo(){
        return this._znp.info()
    }

    getFirmwareInfo() {
        return _.cloneDeep(this._firmware);
    }

    getBufferInfo(){
        const ret = {}
        for(const nwkAddr in this._rebornDevs){
            ret[nwkAddr] = this._rebornDevs[nwkAddr].length
        }
        return ret
    }

    getControllerInfo(){
        const queuedToSend = {}
        for(const dev in this._rebornDevs){
            queuedToSend[dev] = this._rebornDevs[dev].length
        }
        const buffer = this.getBufferInfo()
        return {queuedToSend, buffer}
    }

    getNetInfo() {
        const net = _.cloneDeep(this._net);

        if (net.state === ZSC.ZDO.devStates.ZB_COORD)
            net.state = 'Coordinator';

        net.joinTimeLeft = this._permitJoinTime;

        return net;
    }

    setNetInfo(netInfo) {
        _.forEach(netInfo, (val, key) => {
            if (_.has(this._net, key))
                this._net[key] = val;
        });
    }

    setFirmware(firmwareInfo) {
        this._firmware = firmwareInfo
    }

    /*************************************************************************************************/
    /*** Mandatory Public APIs                                                                     ***/
    /*************************************************************************************************/
    async start() {
        await this._znp.start()
        await init.setupCoord(this)
        console.log('coord ready')
    }

    async close() {
        await this._znp.close()
    }

    async setNvram() {
        const steps = [
            ['SYS', 'osalNvWrite', nvParams.startupOption],//Possibly not 3.x.x?
            ['SYS', 'osalNvWrite', nvParams.panId],
            ['SYS', 'osalNvWrite', nvParams.extPanId],
            ['SYS', 'osalNvWrite', nvParams.channelList],
            ['SYS', 'osalNvWrite', nvParams.logicalType],
            ['SYS', 'osalNvWrite', nvParams.indirectMsgTimeout],
            ['SYS', 'osalNvWrite', nvParams.nwkkey],
            ['SYS', 'osalNvWrite', nvParams.nwkkeyActive],
            ['SYS', 'osalNvWrite', nvParams.precfgkey],
            ['SYS', 'osalNvWrite', nvParams.precfgkeysEnable],
            ['SYS', 'osalNvWrite', nvParams.zdoDirectCb]
        ]
        for (const args of steps) {
            await this.request(...args)
        }
        await Q(this.request('SYS', 'osalNvItemInit', nvParams.znpCfgItem)).delay(10).catch(function (err) {
            return (err.message === 'rsp error: 9') ? null : Q.reject(err);  // Success, item created and initialized
        })
        //await this.request('ZDO', 'extUpdateNwkKey', {dstaddr:0xffff,keyseqnum:0,key:nvParams.nwkkey.value})

        const channelMask = nvParams.channelList.value
        const channelInt = channelMask[0] + (channelMask[1] << 8) + (channelMask[2] << 16) + (channelMask[3] << 24)
        await this.request('APP_CFG', 'bdbSetChannel', { isPrimary: 0x1, channel: channelInt });
        await this.request('APP_CFG', 'bdbSetChannel', { isPrimary: 0x0, channel: 0x0 });
        await this.request('SYS', 'osalNvWrite', {
            id: 0x55,    // 0x2D
            offset: 0,
            len: 0x01,
            value: [0x00]
        })//BDB_NODE_IS_ON_A_NETWORK
    }

    async reset(mode) {
        var deferred = Q.defer(),
            startupOption = nvParams.startupOption.value[0];

        proving.stringOrNumber(mode, 'mode should be a number or a string.');

        this.once('_reset', err => {
            return err ? deferred.reject(err) : deferred.resolve();
        });

        if (mode !== 'hard' && mode !== 0) return
        if (this._nvChanged && startupOption !== 0x02) {
            //nvParams.startupOption.value[0] = 0x02

            await this.setNvram()
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

        const delay = Q.delay(1000)

        await this.request('SYS', 'resetReq', { type: 0x01 })

        await delay

        this._resetting = false;
        if (this._nvChanged) {
            nvParams.startupOption.value[0] = startupOption;
            this._nvChanged = false;
        }
    }

    async request(subsys, cmdId, valObj) {
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

        if ((subsys !== 'ZDO' && subsys !== 5) && rsp && rsp.status !== undefined && rsp.status !== 0) {
            throw new Error('rsp error: ' + rsp.status)
        }

        return rsp
    }

    async permitJoin(time, type) {
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

        const rsp = await this.request('ZDO', 'mgmtPermitJoinReq', { addrmode: addrmode, dstaddr: dstaddr, duration: time, tcsignificance: 0 });

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

    async remove(dev, cfg) {
        // cfg: { reJoin, rmChildren }
        let reqArgObj,
            rmChildren_reJoin = 0x00;

        if (!(dev instanceof Device))
            throw new TypeError('dev should be an instance of Device class.');
        else if (!_.isPlainObject(cfg))
            throw new TypeError('cfg should be an object.');
        else if (!dev.getNwkAddr())
            throw new TypeError('dev has invalid nwk address');

        cfg.reJoin = cfg.reJoin !== undefined ? !!cfg.reJoin : true;               // defaults to true
        cfg.rmChildren = cfg.rmChildren !== undefined ? !!cfg.rmChildren : false;  // defaults to false

        rmChildren_reJoin = cfg.reJoin ? (rmChildren_reJoin | 0x01) : rmChildren_reJoin;
        rmChildren_reJoin = cfg.rmChildren ? (rmChildren_reJoin | 0x02) : rmChildren_reJoin;

        reqArgObj = {
            dstaddr: cfg.nwkAddr === undefined ? dev.getNwkAddr() : 0,
            deviceaddress: dev.getIeeeAddr(),
            removechildren_rejoin: rmChildren_reJoin
        };

        return await this.request('ZDO', 'mgmtLeaveReq', reqArgObj)
    }

    async registerEp(loEp) {
        if (!(loEp instanceof Coordpoint))
            throw new TypeError('loEp should be an instance of Coordpoint class.');

        try {
            return await this.request('AF', 'register', makeRegParams(loEp))
        } catch (err) {
            if (err.message === 'rsp error: 184') return await this.reRegisterEp(loEp)
            throw err
        }
    }

    async deregisterEp(loEp) {
        if (!(loEp instanceof Coordpoint))
            throw new TypeError('loEp should be an instance of Coordpoint class.');

        const rsp = await this.request('AF', 'delete', { endpoint: loEp.getEpId() });
        this.getCoord().removeEndpoint(loEp.getEpId())

        return rsp
    }

    async reRegisterEp(loEp) {
        await this.deregisterEp(loEp)
        return await this.request('AF', 'register', makeRegParams(loEp));
    }

    simpleDescReq(nwkAddr, ieeeAddr) {
        return this.querie.deviceWithEndpoints(nwkAddr, ieeeAddr);
    }

    bind(srcEp, cId, dstEpOrGrpId) {
        return this.querie.setBindingEntry('bind', srcEp, cId, dstEpOrGrpId);
    }

    unbind(srcEp, cId, dstEpOrGrpId) {
        return this.querie.setBindingEntry('unbind', srcEp, cId, dstEpOrGrpId);
    }

    async findEndpoint(addr, epId) {
        return await this._shepherd.find(addr, epId);
    }

    shouldSendIndrect() {
        return true
    }

    setNvParams(net) {
        // net: { panId, channelList, precfgkey, precfgkeysEnable, startoptClearState }
        net = net || {};
        proving.object(net, 'opts.net should be an object.');

        _.forEach(net, function (val, param) {
            switch (param) {
                case 'panId':
                    proving.number(val, 'net.panId should be a number.');
                    nvParams.panId.value = [val & 0xFF, (val >> 8) & 0xFF];
                    break;
                case 'precfgkey':
                    if (!_.isArray(val) || val.length !== 16)
                        throw new TypeError('net.precfgkey should be an array with 16 uint8 integers.');
                    nvParams.precfgkey.value = val;
                    //nvParams.nwkkey.value = val;
                    break;
                case 'precfgkeysEnable':
                    proving.boolean(val, 'net.precfgkeysEnable should be a bool.');
                    nvParams.precfgkeysEnable.value = val ? [0x01] : [0x00];
                    break;
                case 'startoptClearState':
                    proving.boolean(val, 'net.startoptClearState should be a bool.');
                    nvParams.startupOption.value = val ? [0x02] : [0x00];
                    break;
                case 'channelList':
                    proving.array(val, 'net.channelList should be an array.');
                    var chList = 0;

                    _.forEach(val, function (ch) {
                        if (ch >= 11 && ch <= 26)
                            chList = chList | ZSC.ZDO.channelMask['CH' + ch];
                    });

                    nvParams.channelList.value = [chList & 0xFF, (chList >> 8) & 0xFF, (chList >> 16) & 0xFF, (chList >> 24) & 0xFF];
                    break;
                default:
                    throw new TypeError('Unkown argument: ' + param + '.');
            }
        });
    }

    async checkNvParams() {
        function bufToArray(buf) {
            var arr = [];

            for (var i = 0; i < buf.length; i += 1) {
                arr.push(buf.readUInt8(i));
            }

            return arr;
        }

        const nvItems = ['panId', 'channelList', 'precfgkey', 'precfgkeysEnable', 'indirectMsgTimeout', "zdoDirectCb", 'nwkkey', 'nwkkeyActive']
        for (const nvItem of nvItems) {
            const nv = nvParams[nvItem]
            const rsp = await this.request('SYS', 'osalNvRead', nv)
            if(rsp === null) throw new Error(`Failed to read nvram ${nvItem}`)
            if (!_.isEqual(bufToArray(rsp.value.slice(0, nv.len)), nv.value)) {
                this._nvChanged = true;
                debug.init('Non-Volatile memory is changed (' + nvItem + ').');
                if (nvItem === 'channelList') {
                    await this.setNvram()
                } else {
                    return await this.reset('hard');
                }
            }
        }
    }

    async checkOnline(dev) {
        var nwkAddr = dev.getNwkAddr(),
            ieeeAddr = dev.getIeeeAddr();

        if (typeof nwkAddr == "undefined") return null;

        try {
            await Q(this.request('ZDO', 'nodeDescReq', { dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr })).timeout(5000)
        } catch (err) {
            return
        }
        if (dev.status === 'offline' && nwkAddr) {
            this.emit('ZDO:endDeviceAnnceInd', { srcaddr: nwkAddr, nwkaddr: nwkAddr, ieeeaddr: ieeeAddr });
        }
    }

    async _afDispatch(af, type, msg) {
        let targetEp, remoteEp
        let coord = this.getCoord()

        if (msg.endpoint !== undefined) {                                               // dataConfirm, reflectError
            if (!coord) {
                debug.shepherd("skipping message as coord not initialized")
                return
            }
            targetEp = coord.getEndpoint(msg.endpoint);                  //  => find local ep, such a message is going to local ep
        } else if (msg.srcaddr !== undefined && msg.srcendpoint !== undefined) {    // incomingMsg, incomingMsgExt, zclIncomingMsg
            if (!coord) {
                debug.shepherd("skipping message as coord not initialized")
                return
            }
            targetEp = coord.getEndpoint(msg.dstendpoint);               //  => find local ep

            if (targetEp) {  // local
                remoteEp = await this.findEndpoint(msg.srcaddr, msg.srcendpoint);

                if (!remoteEp) {        // local zApp not found, get ieeeaddr and emit fake 'endDeviceAnnceInd' msg
                    let dev = this._shepherd.findDevByAddr(msg.srcaddr)
                    debug.shepherd(`missing db entry for ${msg.srcaddr}`)
                    if (dev) remoteEp = new Endpoint(dev, { epId: msg.srcendpoint }, this._shepherd)
                    const deferred = Q.defer()

                    if (!dev) {
                        let rsp
                        try {
                            rsp = await this.request('ZDO', 'ieeeAddrReq', { shortaddr: msg.srcaddr, reqtype: 0, startindex: 0 })
                            debug.shepherd(`found ieee for missing db entry ${msg.srcaddr} "${rsp.ieeeaddr}"`)
                        } catch (err) {
                            debug.shepherd("failed to get IEEE address for device that communicated with us... Error: %s", err)
                            return
                        }

                        dev = this._shepherd.findDevByAddr(rsp.ieeeaddr)
                        if (dev) {
                            debug.shepherd(`updating altNwk for "${rsp.ieeeaddr}" to  ${msg.srcaddr}`)
                            dev.addAltNwk(dev.nwkAddr)
                            await dev.update({ nwkAddr: msg.srcaddr })
                        } else {
                            let msgBuffer = this._rebornDevs[msg.srcaddr];
                            if (msgBuffer) {
                                while(msgBuffer.length > MaxQueuedPackets){
                                    msgBuffer.shift()
                                }
                                msgBuffer.push({ type, msg });
                                debug.shepherd(`queued packet for "${rsp.ieeeaddr}", there is now ${msgBuffer.length} packets queueud`)
                            } else if (msgBuffer === undefined) {
                                msgBuffer = this._rebornDevs[msg.srcaddr] = [{ targetEp, type, msg, deferred }];

                                this.joinHandler({ srcaddr: rsp.nwkaddr, nwkaddr: rsp.nwkaddr, ieeeaddr: rsp.ieeeaddr }, false).then(function(dev){
                                    debug.shepherd(`clearing queued packets for "${rsp.ieeeaddr}"`)
                                    delete this._rebornDevs[msg.srcaddr]

                                    debug.shepherd(`completed ${dev?'successfull':'failed'} recovery join for "${rsp.ieeeaddr}"`)
                                    if(dev){
                                        if (remoteEp && Array.isArray(msgBuffer))
                                            for (const item of msgBuffer) {
                                                af.dispatchIncomingMsg(item.targetEp, item.type, item.msg).then(item.deferred.resolve, item.deferred.reject);
                                            }
                                    }
                                }, ()=>{})
                            }
                            return await deferred.promise
                        }
                    }
                }
            }
        }

        if (!targetEp) {     // if target not found, ignore this message
            debug.shepherd(`Endpoint ${msg.endpoint || msg.dstendpoint} not found, ignoring message`)
            return;
        }

        return af.dispatchIncomingMsg(targetEp, remoteEp, type, msg)
    }

    deviceWithEndpoints(ieeeAddr, epList, nwkAddr) {
        var epQueries = []

        for (var i = 0; i < epList.length; i++) {
            var epQuery = this.querie.endpoint(ieeeAddr, nwkAddr, epList[i]);
            epQueries.push(epQuery);
        }

        return Q.all(epQueries);
    }

    async joinHandler(data, abortExisting) {
        if (data.ieeeaddr == "0xffffffffffffffff" || data.ieeeaddr == "0x0000000000000000") {
            debug.shepherd("Received likely incorrect IEEE from faulty device '%s'. We will ignore.", data.ieeeaddr)
            return true
        }

        var ret = Q.defer()

        // Join locking
        let joinLock = this._joinLocks[data.ieeeaddr]
        if (!joinLock) {
            joinLock = this._joinLocks[data.ieeeaddr] = { queue: [] }
        }
        if (this._joinWaitList[data.ieeeaddr]) {
            clearTimeout(this._joinWaitList[data.ieeeaddr]);
            delete this._joinWaitList[data.ieeeaddr];
        }


        /* If we are certain this is the join we care about then clear existing */
        if (abortExisting) {
            let abortedAddrs = []
            for (let i = 0; i < joinLock.queue.length; i++) {
                let entry = joinLock.queue[i]
                if (entry.ieeeAddr == data.ieeeaddr && entry.nwkAddr != data.nwkaddr) {
                    entry.aborted(true)
                    joinLock.queue.splice(i, 1)
                    i--
                    abortedAddrs.push(data.nwkaddr)
                }
            }
            for (let i = 0; i < abortedAddrs.length; i++) {
                this._zdo.emit(abortedAddrs[i].toString(16))
            }
            if (abortedAddrs.length) {
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

                let intermediary = Q.defer()
                try {
                    const r = await this._endDeviceAnnceHdlr(data, joinEntry.aborted);
                    intermediary.resolve(r)
                } catch (err) {
                    intermediary.reject(err)
                    this.getShepherd().emit('error', 'Device ' + data.ieeeaddr + " failed the joining process due to: " + err.message);
                }


                /* Remove current */
                var index = joinLock.queue.indexOf(joinEntry);
                if (index !== -1) {
                    joinLock.queue.splice(index, 1);
                }

                // pass on result
                intermediary.promise.then(ret.resolve, ret.reject)

                debug.shepherd("** Done %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))

                /* Execute latest */
                if (joinLock.queue.length) {
                    Q.fcall(joinLock.queue[joinLock.queue.length - 1].fn)
                }
            },
            aborted: function (abort) {
                if (abort) {
                    _abort = new Error('__abort__')
                    ret.reject("aborted")
                }
                return _abort
            }
        }


        for (let i = 0; i < joinLock.queue.length; i++) {
            let entry = joinLock.queue[i]
            if (entry.ieeeAddr == joinEntry.ieeeAddr && entry.nwkAddr == joinEntry.nwkAddr) {
                debug.shepherd("** Already exists in queue %s (0x%s)", entry.ieeeAddr, entry.nwkAddr.toString(16))
                return
            }
        }

        joinLock.queue.push(joinEntry)
        if (joinLock.queue.length == 1) {
            debug.shepherd("** Executing join for %s (0x%s) as was idle", joinEntry.ieeeAddr, joinEntry.nwkAddr.toString(16))
            await joinLock.queue[0].fn()
        } else {
            debug.shepherd("** Added join for %s (0x%s) to queue", joinEntry.ieeeAddr, joinEntry.nwkAddr.toString(16))
        }

        return await ret.promise;
    }

    async _queryBasic(dev, aborted) {
        const devInfo = await retry(async () => {
            if (aborted()) throw aborted()
            return await this.simpleDescReq(dev.nwkAddr, dev.ieeeAddr) // concurrency limited by querie functions
        }, 2)

        if (aborted()) throw aborted()
        if (devInfo.capabilities) dev.capabilities = devInfo.capabilities;

        /* Construct endpoints */
        const endpoints = {}
        for (const i in devInfo.endpoints) {
            let ep = new Endpoint(dev, devInfo.endpoints[i], this._shepherd);
            if (!this._shepherd.interestedEndpoint(ep, null)) {
                continue
            }
            ep.clusters = new Ziee();
            endpoints[ep.getEpId()] = ep;
        }
        devInfo.endpoints = endpoints

        await dev.update(devInfo)

        if (aborted()) throw aborted()
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
                if (aborted()) throw aborted()
                return this.limitConcurrency(() =>
                    this._shepherd.af.zclFoundation(this.getCoord().getDelegator(), basicEpInst, 0, 'read', [{ attrId: 4 }, { attrId: 5 }, { attrId: 7 }])
                )()
            }, 3)
        } catch (err) {
            throw new Error("Unable to query manditory cluster genBasic, error: " + err);
        }

        let data = {};
        if (readStatusRecsRsp && Array.isArray(readStatusRecsRsp.payload)) {
            for (const item of readStatusRecsRsp.payload) {
                // item { attrId, status, dataType, attrData }
                if (item && item.attrData) {
                    if (item.attrId === 7)
                        data[attrMap[item.attrId]] = powerSourceMap[item.attrData];
                    else
                        data[attrMap[item.attrId]] = item.attrData;
                }
            }
        }

        // Ask with genBasic
        let changed = false
        for (const epId in devInfo.endpoints) {
            const ep = devInfo.endpoints[epId]

            if (!this._shepherd.interestedEndpoint(ep, data)) {
                delete devInfo.endpoints[epId]
                changed = true
            }
        }
        if (changed) {
            await dev.update(devInfo)
        }

        return data
    }

    async _fullInterview(dev, aborted, interested) {
        const interviewEvents = new EventEmitter();
        const endpoints = dev.getEndpointList()
        interviewEvents.on('ind:interview', status => {
            if (status && status.endpoint) status.endpoint.total = endpoints.length;
            this._shepherd.emit('ind:interview', dev.ieeeAddr, status);
        });

        debug.shepherd('Device: %s starting interview for %d endpoints with interest in %s.', dev.getIeeeAddr(), endpoints.length, JSON.stringify(interested));
        for (const ep of endpoints) {
            if (aborted()) throw aborted()
            const clusters = await this._shepherd.af.zclClustersReq(this.getCoord().getDelegator(), ep, interviewEvents, interested)
            if (aborted()) throw aborted()
            for (const cId in clusters) {
                const cInfo = clusters[cId]
                if (cInfo.dir) ep.clusters.init(cId, 'dir', { value: cInfo.dir });
                ep.clusters.init(cId, 'attrs', cInfo.attrs, false);
            }
        }
    }

    async _endDeviceAnnceHdlr(data, aborted) {
        var joinTimeout,
            joinEvent = 'ind:incoming:' + data.ieeeaddr,
            dev = this._shepherd.findDevByAddr(data.ieeeaddr);

        if (dev && dev.status == "online" && dev.nwkAddr == data.nwkaddr && dev.completeAndReady) {
            // Send again in case we missed previously
            this._shepherd.emit('ind:incoming', dev);
            this._shepherd.emit('ind:status', dev, 'online');
            return
        }

        /* Join timeout notification & Join Queue */
        const timeoutHandle = () => {

            joinTimeout = null;
            this.emit(joinEvent, '__timeout__');
            this._shepherd.emit('joining', { type: 'timeout', ieeeAddr: data.ieeeaddr });
        }
        joinTimeout = setTimeout(timeoutHandle, 60000);

        try {
            /* Join is starting */
            debug.shepherd("** Associating %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
            this._shepherd.emit('joining', { type: 'associating', ieeeAddr: data.ieeeaddr, nwkAddr: data.nwkaddr });

            /* If this is a new device, create a new object */
            if (dev) {
                // Create a fake device until we are sure this is good to overwrite the existing
                if (dev.nwkAddr != data.nwkaddr) {
                    dev = new JoiningDevice(this._shepherd.devstore, dev.dump(), this._shepherd)
                    await dev.update({nwkAddr: data.nwkaddr})
                }
            } else {
                dev = new Device(this._shepherd.devstore, { ieeeAddr: data.ieeeaddr, nwkAddr: data.nwkaddr });
                await dev.insert()
                await this._shepherd._onDeviceWrite()
            }

            /* Fill out endoints */
            if (dev.incomplete) {
                debug.shepherd("** Identifying %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
                const basicData = await this._queryBasic(dev, aborted)

                // Update dev
                await dev.update(basicData);

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
            if (aborted()) throw aborted()
            if (!interested) {
                debug.shepherd("Rejected during Interview")
                return /* rejection during interview */
            }

            /* Full Interview */
            debug.shepherd("** Interviewing %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
            if (dev.incomplete) {
                if (aborted()) throw aborted()

                await this._fullInterview(dev, aborted, interested)
            }

            /* All the endpoints we will ever get */
            info.endpoints = dev.getEndpointList()
            if (!info.endpoints.length) {
                throw new Error('no eps')
            }

            /* Final Accept */
            debug.shepherd("** Accepting %s (0x%s)", data.ieeeaddr, data.nwkaddr.toString(16))
            const result = await Q(this._shepherd.acceptDevIncoming(info)).timeout(6000)

            await dev.update({ status: 'online', complete: true, nwkAddr: data.nwkaddr })
            await this._shepherd._onDeviceWrite()
            if (!result) {
                debug.shepherd("Rejected during final stage")
                await dev.update({ rejected: 'final' })
                return
            }
            await dev.update({ rejected: undefined })

            if (aborted()) throw aborted()

            /* Verdict */
            await dev.clearAltNwk()
            await this._shepherd._onDeviceWrite()
            debug.shepherd('Device %s joins the network.', dev.getIeeeAddr());

            this._shepherd.emit('ind:incoming', dev);
            this._shepherd.emit('ind:status', dev, 'online');
            this.emit('ind:incoming:' + dev.getIeeeAddr());
            this.emit(joinEvent);

            return dev
        } catch (err) {
            /* Error Handling */
            if (err.stack) debug.shepherd(err.stack)
            this._shepherd.emit('error', 'Device ' + data.ieeeaddr + " failed to join due to error: " + err);
            this._shepherd.emit('joining', { type: 'error', ieeeAddr: data.ieeeaddr })
        } finally {
            if(joinTimeout){
                clearTimeout(joinTimeout)
                joinTimeout = null
            }
        }
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

function retry(fn, n) {
    var start = Q.fcall(fn)
    for (var i = 0; i < n; i++) {
        start = start.catch(fn)
    }
    return start
}

module.exports = Controller;
