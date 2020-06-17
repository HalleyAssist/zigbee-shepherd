/* jshint node: true */
'use strict';

var ZSC = require('zstack-common').constants,
    NVID16 = ZSC.SYS.nvItemIds;

var nvParams = {
    startupOption: { 
        id: NVID16.STARTUP_OPTION,     // 0x03
        offset: 0,
        len: 0x01,
        value: [ 0x00 ]
    },
    panId: {
        id: NVID16.PANID,              // 0x83
        offset: 0,
        len: 0x02,
        value: [ 0xFF, 0xFF ]
    },
    extPanId: {
        id: NVID16.EXTENDED_PAN_ID,    // 0x2D
        offset: 0,
        len: 0x08,
        value: [ 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD ]
    },
    channelList: {
        id: NVID16.CHANLIST,           // 0x84
        offset: 0,
        len: 0x04,
        value: [ 0x00, 0x08, 0x00, 0x00 ]   // Little endian. Default is 0x00000800 for CH11;  Ex: value: [ 0x00, 0x00, 0x00, 0x04 ] for CH26, [ 0x00, 0x00, 0x20, 0x00 ] for CH15.
    },
    logicalType: {
        id: NVID16.LOGICAL_TYPE,       // 0x87
        offset: 0,
        len: 0x01,
        value: [ 0x00 ]
    },
    nwkkey: {
        id: NVID16.NKWKEY,          // 0x82
        offset: 1,
        len: 0x10,
        value: [ 0x5a, 0x69, 0x67, 0x42, 0x65, 0x65, 0x41, 0x6c, 0x6c, 0x69, 0x61, 0x6e, 0x63, 0x65, 0x30, 0x39 ]
    },
    precfgkey: {
        id: NVID16.PRECFGKEY,          // 0x62
        offset: 0,
        len: 0x10,
        value: [ 0x01, 0x03, 0x05, 0x07, 0x09, 0x0B, 0x0D, 0x0F, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0A, 0x0C, 0x0D ]
    },
    precfgkeysEnable: {
        id: NVID16.PRECFGKEYS_ENABLE,  // 0x63
        offset: 0,
        len: 0x01,
        value: [ 0x00 ]
        // value: 0 (FALSE) only coord defualtKey need to be set, and OTA to set other devices in the network.
        // value: 1 (TRUE) Not only coord, but also all devices need to set their defualtKey (the same key). Or they can't not join the network.
    },
    zdoDirectCb: {
        id: NVID16.ZDO_DIRECT_CB,      // 0x8F
        offset: 0,
        len: 0x01,
        value: [ 0x01 ]
    },
    tclkStart: {
        id: NVID16.TCLK_TABLE_START,        // 0x0111
        offset: 0x00,
        len: 0x20,
        // ZigBee Alliance Pre-configured TC Link Key - 'ZigBeeAlliance09'
        value: [ 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x5a, 0x69, 0x67, 0x42, 0x65, 0x65, 0x41, 0x6c,
                 0x6c, 0x69, 0x61, 0x6e, 0x63, 0x65, 0x30, 0x39, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 ]
    },
    znpCfgItem: {
        id: NVID16.ZNP_HAS_CONFIGURED,      // 0x0F00
        len: 0x01,
        initlen: 0x01,
        initvalue: [ 0x00 ]
    },
    znpHasConfigured: {
        id: NVID16.ZNP_HAS_CONFIGURED,      // 0x0F00
        offset: 0x00,
        len: 0x01,
        value: [ 0x55 ]
    },
    afRegister: {
        endpoint: 0x08,
        appprofid: 0xBF0D,
        appdeviceid: 0x0501,
        appdevver: 0x01,
        latencyreq: 0x00,
        appnuminclusters: 0x04,
        appinclusterlist: [ 0x00, 0x00, 0x15, 0x00, 0x02, 0x07, 0x00, 0x04 ],
        appnumoutclusters: 0x00,
        appoutclusterlist: []
    }
};

module.exports = nvParams;
