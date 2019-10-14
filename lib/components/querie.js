/* jshint node: true */
'use strict';

var Q = require('q'),
    _ = require('busyman'),
    zclId = require('zcl-id'),
    proving = require('proving'),
    assert = require('assert'),
    ZSC = require('zstack-constants');

var zutils = require('./zutils');

var controller,
    querie = {};

/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
querie.coordInfo = function () {
    var info = controller.getNetInfo();
    return querie.device(info.ieeeAddr, info.nwkAddr);
};

querie.coordState = function () {
    return querie.network('DEV_STATE');
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
    var devInfo = {
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
    var fullDev;

    const devInfo = await querie.device(ieeeAddr, nwkAddr)

    fullDev = devInfo;
    var epInfos = [], epQueries = [];

    _.forEach(fullDev.epList, function (epId) {
        epQueries.push(async (epInfos) => {
            const epInfo = await querie.endpoint(ieeeAddr, nwkAddr, epId)
            epInfos.push(epInfo);
            return epInfos;
        });
    });

    await epQueries.reduce(function (soFar, fn) {
        return soFar.then(fn);
    }, Q(epInfos));
    
    fullDev.endpoints = epInfos;
    return fullDev
};

querie.setBindingEntry = async function (bindMode, srcEp, cId, dstEpOrGrpId) {
    var cIdItem = zclId.cluster(cId),
        bindParams,
        dstEp,
        grpId

    assert (srcEp.isEndpoint && srcEp.isEndpoint(true), 'srcEp should be an instance of Endpoint class.')

    proving.defined(cIdItem, 'Invalid cluster id: ' + cId + '.');

    if (_.isNumber(dstEpOrGrpId) && !_.isNaN(dstEpOrGrpId))
        grpId = dstEpOrGrpId;
    else
        dstEp = dstEpOrGrpId;

    bindParams = {
        dstaddr: srcEp.getNwkAddr(),
        srcaddr: srcEp.getIeeeAddr(),
        srcendpoint: srcEp.getEpId(),
        clusterid: cIdItem.value,
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
querie._network = async function (param) {
    var prop = ZSC.SAPI.zbDeviceInfo[param];

    if (_.isNil(prop))
        throw new Error('Unknown network property.')
    
    const rsp = await controller.request('SAPI', 'getDeviceInfo', { param: prop });
    
    switch (param) {
        case 'DEV_STATE':
        case 'CHANNEL':
            return rsp.value.readUInt8(0);
        case 'IEEE_ADDR':
        case 'PARENT_IEEE_ADDR':
        case 'EXT_PAN_ID':
            return addrBuf2Str(rsp.value);
        case 'SHORT_ADDR':
        case 'PARENT_SHORT_ADDR':
            return rsp.value.readUInt16LE(0);
        case 'PAN_ID':
            return zutils.toHexString(rsp.value.readUInt16LE(0), 'uint16');
    }
};

querie._networkAll = async function () {
    var paramsInfo = [
            { param: 'DEV_STATE',  name: 'state'   }, { param: 'IEEE_ADDR',  name: 'ieeeAddr' },
            { param: 'SHORT_ADDR', name: 'nwkAddr' }, { param: 'CHANNEL',    name: 'channel'  },
            { param: 'PAN_ID',     name: 'panId'   }, { param: 'EXT_PAN_ID', name: 'extPanId' }
        ],
        net = {
            state: null,
            channel: null,
            panId: null,
            extPanId: null,
            ieeeAddr: null,
            nwkAddr: null
        },
        steps = [];

    _.forEach(paramsInfo, function (paramInfo) {
        steps.push(async (net) => {
            const value = await querie._network(paramInfo.param)
            net[paramInfo.name] = value;
            return net;
        });
    });

    return await steps.reduce(function (soFar, fn) {
        return soFar.then(fn);
    }, Q(net))
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