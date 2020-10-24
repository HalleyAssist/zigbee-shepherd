/* jshint node: true */
'use strict';

var _ = require('busyman'),
    zclId = require('zcl-id'),
    ZigbeeError = require('./errors/zigbee_error'),
    Debug = require('debug')

function Endpoint(device, simpleDesc, shepherd) { 
    // simpleDesc = { profId, epId, devId, inClusterList, outClusterList }

    this.shepherd = shepherd
    this.device = device;                               // bind to device
    this.profId = simpleDesc.profId;
    this.epId = simpleDesc.epId;
    this.devId = simpleDesc.devId;
    this.inClusterList = simpleDesc.inClusterList;      // numbered cluster ids
    this.outClusterList = simpleDesc.outClusterList;    // numbered cluster ids

    this.clusters = null;    // instance of ziee

    // this.clusters.dumpSync()
    // {
    //     genBasic: {
    //         dir: { value: 1 },  // 0: 'unknown', 1: 'in', 2: 'out', 3: 'in' and 'out'
    //         attrs: {
    //             hwVersion: 0,
    //             zclVersion: 1
    //         }
    //     }
    // }

    this.onAfDataConfirm = null;
    this.onAfReflectError = null;
    this.onAfIncomingMsg = null;
    this.onAfIncomingMsgExt = null;
    this.onZclFoundation = null;
    this.onZclFunctional = null;
    this._logger = Debug(`zigbee-shepherd:0x${device.getNwkAddr().toString(16)}:${this.epId}`) 
}

Endpoint.prototype.getSrcRtg = function(){
    const device = this.getDevice()
    return device.getSrcRtg()
}

/*************************************************************************************************/
/*** Public Methods                                                                            ***/
/*************************************************************************************************/
Endpoint.prototype.getSimpleDesc = function () {
    return {
        profId: this.profId,
        epId: this.epId,
        devId: this.devId,
        inClusterList: _.cloneDeep(this.inClusterList),
        outClusterList: _.cloneDeep(this.outClusterList),
    };
};

Endpoint.prototype.getIeeeAddr = function () {
    return this.getDevice().getIeeeAddr();
};

Endpoint.prototype.getNwkAddr = function () {
    return this.getDevice().getNwkAddr();
};

Endpoint.prototype.dump = function () {
    var dumped = this.getSimpleDesc();

    dumped.clusters = this.clusters.dumpSync();

    return dumped;
};

// zcl and binding methods will be attached in shepherd
// endpoint.foundation = function (cId, cmd, zclData[, cfg]) {};
// endpoint.functional = function (cId, cmd, zclData[, cfg]) {};
// endpoint.read = function (cId, attrId) {};
// endpoint.bind = function (cId, dstEpOrGrpId) {};
// endpoint.unbind = function (cId, dstEpOrGrpId) {};

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/
Endpoint.prototype.isZclSupported = function () {
    var zclSupport = false;

    if (this.profId < 0x8000 && this.devId < 0xc000)
        zclSupport = true;

    this.isZclSupported = function () {
        return zclSupport;
    };

    return zclSupport;
};

Endpoint.prototype.getDevice = function () {
    return this.device;
};

Endpoint.prototype.getProfId = function () {
    return this.profId;
};

Endpoint.prototype.getEpId = function () {
    return this.epId;
};

Endpoint.prototype.getDevId = function () {
    return this.devId;
};

Endpoint.prototype.getInClusterList = function () {
    return [...this.inClusterList];
};

Endpoint.prototype.getOutClusterList = function () {
    return [...this.outClusterList];
};

Endpoint.prototype.getClusterList = function () {
    var clusterList = this.getInClusterList();

    this.getOutClusterList().forEach(function (cId) {
        if (!clusterList.includes(cId)) 
            clusterList.push(cId);
    });

    return clusterList.sort(function (a, b) { return a - b; });
};

Endpoint.prototype.getClusters = function () {
    return this.clusters;
};

Endpoint.prototype.getManufId = function () {
    return this.getDevice().getManufId();
};

Endpoint.prototype.update = function (simpleDesc) {
    const descKeys = [ 'profId', 'epId', 'devId','inClusterList', 'outClusterList' ];

    for(const key in simpleDesc){
        if (descKeys.includes(key))
            this[key] = simpleDesc[key];
    }
};

Endpoint.prototype.isEndpoint = function(localEndpoint = null){
    if(localEndpoint === null) return true;
    return this.isLocal() == localEndpoint
}

Endpoint.prototype.isLocal = Endpoint.prototype.isDelegator = ()=>false


Endpoint.prototype.foundation = async function(cId, cmd, zclData, cfg) {
    this._logger(`zcl:foundation(${cmd}) ${JSON.stringify(zclData)}`)
    return await this.shepherd._foundation(null, this, cId, cmd, zclData, cfg);
};
Endpoint.prototype.functional = async function(cId, cmd, zclData, cfg) {
    this._logger(`zcl:functional(${cmd}) ${JSON.stringify(zclData)}`)
    return await this.shepherd._functional(null, this, cId, cmd, zclData, cfg);
};
Endpoint.prototype.bind = async function(cId, dstEpOrGrpId) {
    return await this.shepherd.controller.bind(this, cId, dstEpOrGrpId);
};
Endpoint.prototype.unbind = async function(cId, dstEpOrGrpId) {
    return await this.shepherd.controller.unbind(this, cId, dstEpOrGrpId);
};
Endpoint.prototype.read = async function (cId, attrId) {
    var attr = zclId.attr(cId, attrId);

    attr = attr ? attr.value : attrId;

    const readStatusRecsRsp = await this.shepherd._foundation(this, this, cId, 'read', [{ attrId: attr }])
    var rec = readStatusRecsRsp[0];

    if (rec.status) throw new ZigbeeError('request unsuccess: ' + rec.status, rec.status);
    return rec.attrData;
        
};
Endpoint.prototype.write = async function (cId, attrId, data) {
    var attr = zclId.attr(cId, attrId),
        attrType = zclId.attrType(cId, attrId).value;

    const writeStatusRecsRsp = await this.shepherd._foundation(this, this, cId, 'write', [{ attrId: attr.value, dataType: attrType, attrData: data }])
    var rec = writeStatusRecsRsp[0];

    if (rec.status)
        throw new ZigbeeError('request unsuccess: ' + rec.status, rec.status)
    return data;
};
Endpoint.prototype.report = async function (cId, attrId, minInt, maxInt, repChange) {
    let coord = this.shepherd.controller.getCoord(),
        dlgEp = coord.getDelegator(this.getProfId()),
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

    if (!dlgEp) throw new Error('Profile: ' + this.getProfId() + ' is not supported.');
    const rsp = await this.bind(cId, dlgEp)
    if (cfgRpt){
        const rsp = await this.foundation(cId, 'configReport', [ cfgRptRec ])
        var status = rsp[0].status;
        if (status !== 0)
            throw new Error(zclId.status(status).key);
    }
    return rsp
};

module.exports = Endpoint;