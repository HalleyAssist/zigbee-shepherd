/* jshint node: true */
'use strict';

const Q = require('q-lite'),
    _ = require('busyman'),
    zclId = require('zcl-id'),
    proving = require('proving'),
    assert = require('assert'),
    common = require('zstack-common'),
    zutils = common.utils,
    ZSC = common.constants;

var controller,
    querie = {};

/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
querie.coordInfo = function () {
    var info = controller.getNetInfo();
    return querie.device(info.ieeeAddr, info.nwkAddr);
};

querie.coordState = async function () {
    return (await querie.network()).state;
};

querie.network = function (param) {
    if (param)
        return querie._network(param);    // return value
    else
        return querie._networkAll();        // return { state, channel, panId, extPanId, ieeeAddr, nwkAddr }
};

querie.firmware = async function(){
    let rsp
    try {
        rsp = await controller.request('SYS', 'version', {})
    } catch(ex){
        return {error: "Unable to get firmware version"}
    }
    return {
        transportrev: rsp.transportrev,
        product: rsp.product,
        version: rsp.majorrel + "." + rsp.minorrel + "." + rsp.maintrel,
        revision: rsp.revision.toString(16)
    }
}

querie.device = async function (ieeeAddr, nwkAddr) {
    const devInfo = {
            type: null,
            ieeeAddr: ieeeAddr,
            nwkAddr: nwkAddr,
            manufId: null,
            epList: null
        };

    proving.string(ieeeAddr, 'ieeeAddr should be a string.');
    proving.number(nwkAddr, 'nwkAddr should be a number.');

    let rsp = await controller.limitConcurrency(
        ()=>controller.indirect_send(nwkAddr, ()=>controller.request('ZDO', 'nodeDescReq', { dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr })),
        ieeeAddr
    )(true)

    // rsp: { srcaddr, status, nwkaddr, logicaltype_cmplxdescavai_userdescavai, ..., manufacturercode, ... }
    devInfo.type = devType(rsp.logicaltype_cmplxdescavai_userdescavai & 0x07);  // logical type: bit0-2
    devInfo.manufId = rsp.manufacturercode;
    rsp = await controller.limitConcurrency(
        ()=>controller.indirect_send(nwkAddr, ()=>controller.request('ZDO', 'activeEpReq', { dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr })),
        ieeeAddr
    )(true)
    
    // rsp: { srcaddr, status, nwkaddr, activeepcount, activeeplist }
    devInfo.epList = bufToArray(rsp.activeeplist, 'uint8');
    return devInfo;
        
};

querie.endpoint = async function (ieeeAddr, nwkAddr, epId) {
    proving.number(nwkAddr, 'nwkAddr should be a number.');

    const rsp = await controller.limitConcurrency(
        ()=>controller.indirect_send(nwkAddr, ()=>controller.request('ZDO', 'simpleDescReq', { dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr, endpoint: epId })),
        ieeeAddr
    )(true)
    
    // rsp: { ..., endpoint, profileid, deviceid, deviceversion, numinclusters, inclusterlist, numoutclusters, outclusterlist }
    return {
        profId: rsp.profileid || 0,
        epId: rsp.endpoint,
        devId: rsp.deviceid || 0,
        inClusterList: bufToArray(rsp.inclusterlist, 'uint16'),
        outClusterList: bufToArray(rsp.outclusterlist, 'uint16')
    };
};

querie.deviceWithEndpoints = async function (nwkAddr, ieeeAddr) {
    const devInfo = await querie.device(ieeeAddr, nwkAddr)

    const fullDev = Object.assign({}, devInfo);
    const epInfos = [], epQueries = [];

    for(const epId of devInfo.epList){
        epQueries.push(async (epInfos) => {
            const epInfo = await querie.endpoint(ieeeAddr, nwkAddr, epId)
            epInfos.push(epInfo);
            return epInfos;
        });
    }

    await epQueries.reduce(function (soFar, fn) {
        return soFar.then(fn);
    }, Q(epInfos));
    
    fullDev.endpoints = epInfos;
    return fullDev
};

querie.setBindingEntry = async function (bindMode, remoteEp, cId, dstEpOrGrpId) {
    var cIdItem = zclId.cluster(cId),
        bindParams,
        dstEp,
        grpId

    assert (remoteEp.isEndpoint && remoteEp.isEndpoint(false), 'remoteEp should be an instance of Endpoint class.')

    proving.defined(cIdItem, 'Invalid cluster id: ' + cId + '.');

    if (_.isNumber(dstEpOrGrpId) && !_.isNaN(dstEpOrGrpId))
        grpId = dstEpOrGrpId;
    else
        dstEp = dstEpOrGrpId;

    bindParams = {
        clusterid: cIdItem.value,

        // this refers to the device
        dstaddr: remoteEp.getNwkAddr(),
        srcaddr: remoteEp.getIeeeAddr(),
        srcendpoint: remoteEp.getEpId(),

        // this refers to us
        dstaddrmode: dstEp ? ZSC.AF.addressMode.ADDR_64BIT : ZSC.AF.addressMode.ADDR_GROUP,
        addr_short_long: dstEp ? dstEp.getIeeeAddr() : zutils.toLongAddrString(grpId),
        dstendpoint: dstEp ? dstEp.getEpId() : 0xFF
    };

    if (bindMode === 0 || bindMode === 'bind') {
        return await controller.request('ZDO', 'bindReq', bindParams);
    } else if (bindMode === 1 || bindMode === 'unbind') {
        return await controller.request('ZDO', 'unbindReq', bindParams);
    }
};

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/

querie._networkAll = async function () {
    const rsp = await controller.request('ZDO', 'extNwkInfo', { });
    const deviceInfo = await controller.request('UTIL', 'getDeviceInfo', { });
    
    return {
        ieeeAddr: deviceInfo.ieeeaddr,
        nwkAddr: rsp.shortaddr,
        state: rsp.devstate,
        panId: rsp.panid,
        extPanId: rsp.extendedpanid,
        channel: rsp.channel
    }
};

function devType(type) {
    var DEVTYPE = ZSC.ZDO.deviceLogicalType;

    switch (type) {
        case DEVTYPE.COORDINATOR:
            return 'Coordinator';
        case DEVTYPE.ROUTER:
            return 'Router';
        case DEVTYPE.ENDDEVICE:
            return 'EndDevice';
        case DEVTYPE.COMPLEX_DESC_AVAIL:
            return 'ComplexDescAvail';
        case DEVTYPE.USER_DESC_AVAIL:
            return 'UserDescAvail';
    }
}

function addrBuf2Str(buf) {
    var val,
        bufLen = buf.length,
        strChunk = '0x';

    for (var i = 0; i < bufLen; i += 1) {
        val = buf.readUInt8(bufLen - i - 1);

        if (val <= 15)
            strChunk += '0' + val.toString(16);
        else
            strChunk += val.toString(16);
    }

    return strChunk;
}

function bufToArray(buf, nip) {
    var i,
        nipArr = [];

    if (nip === 'uint8') {
        for (i = 0; i < buf.length; i += 1) {
            nipArr.push(buf.readUInt8(i));
        }
    } else if (nip === 'uint16') {
        for (i = 0; i < buf.length; i += 2) {
            nipArr.push(buf.readUInt16LE(i));
        }
    }

    return nipArr.sort(function (a, b) { return a - b; });
}

module.exports = function (cntl) {
    controller = cntl;
    return querie;
};