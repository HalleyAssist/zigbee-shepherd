/* jshint node: true */
'use strict';

var Q = require('q'),
    Device = require('../model/device'),
    debug = {
        shepherd: require('debug')('zigbee-shepherd')
    };

var loader = {};

loader.reloadSingleDev = async function (shepherd, devRec) {
    var dev = shepherd._devbox.get(devRec.id);

    if (dev && dev.getIeeeAddr() === devRec.ieeeAddr) {
        return null
    } else if (dev) {
        devRec.id = null;        // give new id to devRec
    }

    var recoveredDev = new Device(devRec);

    recoveredDev._recoverFromRecord(devRec, shepherd);
    return await shepherd._registerDev(recoveredDev);    // return (err, id)
};

loader.reloadDevs = async function (shepherd) {
    var recoveredIds = [];

    try {
        const devRecs = await Q.ninvoke(shepherd._devbox, 'findFromDb', {})
        var all = devRecs.map(function (devRec) {
            if (devRec.nwkAddr !== 0) {  // coordinator
                return loader.reloadSingleDev(shepherd, devRec).then(function (id) {
                    recoveredIds.push(id);
                }).catch(function (err) {
                    recoveredIds.push(null);
                    debug.shepherd("Unable to load device record due to %s", err)
                })
            }
        });

        await Q.all(all)

        return recoveredIds
    }catch(err) {
        debug.shepherd("Unable to load device records due to %s", err)
        throw err
    }
};

loader.reload = async function (shepherd) {
    await loader.reloadDevs(shepherd)
    return await loader.syncDevs(shepherd);
};

loader.syncDevs = async function (shepherd) {
    const devRecs = await Q.ninvoke(shepherd._devbox, 'findFromDb', {})
    var idsNotInBox = [];

    devRecs.forEach(function (devRec) {
        if (!shepherd._devbox.get(devRec.id))
            idsNotInBox.push(devRec.id);
    });

    if (idsNotInBox.length) {
        return await Q.all(idsNotInBox.map((id)=>Q.ninvoke(shepherd._devbox, "remove", id)))
    }
};

module.exports = loader;