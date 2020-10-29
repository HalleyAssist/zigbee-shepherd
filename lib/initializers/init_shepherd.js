/* jshint node: true */
'use strict';

var {Af} = require('zstack-af'),
    debug = require('debug')('zigbee-shepherd:init')

var init = {};

init.setupShepherd = async function (shepherd) {
    var controller = shepherd.controller,
        netInfo;

    debug('zigbee-shepherd booting...');

    // New zstack-af
    const af = new Af(controller);
    
    // attach event listeners (msg handlers and hooks)
    for(const rec of Af.msgHandlers){
        controller.on(rec.evt, msg=>controller._afDispatch(af, rec.hdlr, msg));
    }
    for(const hook of Af.hooks){
        const m = af[hook.hdlr].bind(af)
        controller.on(hook.evt, async msg=>{
            let dev = shepherd.findDevByAddr(msg.dstaddr)
            if(dev) {
                m(dev, msg)
            }
        })
    }

    // map all af events to controller or shepherd
    af.on('all', ({eventName,args})=>{
        if(eventName.startsWith("ind:")) {
            shepherd.emit(eventName, ...args)
        }
        else {
            controller.emit(eventName, ...args)
        }
    })

    shepherd.af = af

    await controller.start()

    // Disable joining for now
    await controller.request('ZDO', 'mgmtPermitJoinReq', { addrmode: 0x02, dstaddr: 0 , duration: 0, tcsignificance: 0 })

    // Set system time
    const now = new Date()
    await controller.request('SYS', 'setTime',
     { utc: 0, year:now.getUTCFullYear(), month:now.getUTCMonth() + 1, day:now.getUTCDate(), 
        hour:now.getUTCHours(), minute:now.getUTCMinutes(), second:now.getUTCSeconds() });

    await controller.getCoord().insert()

    netInfo = controller.getNetInfo();

    debug('Loading devices from database done.');
    debug('zigbee-shepherd is up and ready.');
    
    debug('Network information:');
    debug(' >> State:      %s', netInfo.state);
    debug(' >> Channel:    %s', netInfo.channel);
    debug(' >> PanId:      %s', netInfo.panId);
    debug(' >> Nwk Addr:   %s', netInfo.nwkAddr);
    debug(' >> Ieee Addr:  %s', netInfo.ieeeAddr);
    debug(' >> Ext. PanId: %s', netInfo.extPanId);
};

module.exports = init;
