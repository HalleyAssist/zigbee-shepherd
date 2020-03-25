/* jshint node: true */
'use strict';

var Q = require('q'),
    _ = require('busyman'),
    Ziee = require('ziee'),
    debug = require('debug')('zigbee-shepherd:init'),
    nvParams = require('../config/nv_start_options.js');

var Coordinator = require('../model/coord'),
    Coordpoint = require('../model/coordpoint');

var init = {};

/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
init.setupCoord = async function (controller) {
    await controller.checkNvParams()
    const netInfo = await init._bootCoordFromApp(controller)
    return await init._registerDelegators(controller, netInfo);
};

/*************************************************************************************************/
/*** Private APIs                                                                              ***/
/*************************************************************************************************/
init._bootCoordFromApp = async function (controller) {    
    const state = await controller.querie.coordState()
    
    //if (state !== 'ZB_COORD' && state !== 0x09) {
        debug('Start the ZNP as a coordinator...');
        await init._startupCoord(controller);
    //}
    
    
    debug('Now the ZNP is a coordinator.');
        
    const firmwareInfo = await controller.querie.firmware()
    controller.setFirmware(firmwareInfo)

    const netInfo = await controller.querie.network()
    // netInfo: { state, channel, panId, extPanId, ieeeAddr, nwkAddr }
    controller.setNetInfo(netInfo);
    return netInfo;
};

init._startupCoord = async function (controller) {
    var deferred = Q.defer(),
        stateChangeHdlr;

    stateChangeHdlr = function (data) {
        //if (data.state === 9) {
            deferred.resolve();
            controller.removeListener('APP_CFG:bdbCommissioningInd', stateChangeHdlr);
        //}
    };

    controller.on('APP_CFG:bdbCommissioningInd', stateChangeHdlr);

    await controller.request('ZDO', 'startupFromApp', { startdelay: 10 });

    return deferred.promise;
};

init._registerDelegators = async function (controller, netInfo) {
    var coord = controller.getCoord(),
        dlgInfos =  [
            { profId: 0x0104, epId: 1 }
        ];

    const devInfo = await controller.simpleDescReq(0, netInfo.ieeeAddr)

    for(const endpoint in devInfo.epList){
        if (endpoint > 10) {
            await controller.request('AF', 'delete', { endpoint })
        }
    }


    if (!coord)
        coord = controller._coord = new Coordinator(devInfo);
    else
        coord.endpoints = {};

    for(const epId in devInfo.endpoints){
        const coordPoint = new Coordpoint(coord, devInfo.endpoints[epId], false)
        coordPoint.clusters = new Ziee();
        devInfo.endpoints[epId] = coordPoint
    }
    for (const dlgInfo of dlgInfos) {
        let dlgDesc = { profId: dlgInfo.profId, epId: dlgInfo.epId, devId: 0x0005, inClusterList: [], outClusterList: [] },
            dlgEp = new Coordpoint(coord, dlgDesc, true)

        dlgEp.clusters = new Ziee();
        const existing = devInfo.endpoints[dlgEp.getEpId()]
        if(!_.isEqual(dlgDesc, existing)){
            debug('Register delegator, epId: %s, profId: %s ', dlgEp.getEpId(), dlgEp.getProfId());
            devInfo.endpoints[dlgEp.getEpId()] = dlgEp;
            await controller.registerEp(dlgEp)
        }
    }

    coord.endpoints = devInfo.endpoints

    const coordInfo = await controller.querie.coordInfo()
    await coord.update(coordInfo)
};

module.exports = init;
