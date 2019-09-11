/* jshint node: true */
'use strict';

var EventEmitter = require('events');

var Q = require('q'),
    _ = require('busyman'),
    Areq = require('areq'),
    zclId = require('zcl-id'),
    proving = require('proving'),
    ZSC = require('zstack-constants')

var zcl = require('./zcl'),
    zutils = require('./zutils'),
    Endpoint = require('../model/endpoint'),
    Coordpoint = require('../model/coordpoint'),
    seqNumber = 0,
    rebornDevs = {},  // { nwkAddr: [ { type, msg } ], ... };
	debug = require('debug')("zigbee-shepherd:af");

var af = {
    controller: null,
    areq: null,
    _seq: 0,
    indirectTimeout: 50000,
    resendTimeout: 30000,
    maxTransactions: 250
};

function format_af_error(errText, statusCode){
    var ret = errText + statusCode

    if (statusCode === 0xcd || statusCode === 'NWK_NO_ROUTE')
        ret += ". No network route. Please confirm that the device has (re)joined the network."
    else if (statusCode === 0xe9 || statusCode === 'MAC_NO_ACK')
        ret += ". MAC no ack."
    else if (statusCode === 0xb7 || statusCode === 'APS_NO_ACK')                // ZApsNoAck period is 20 secs
        ret += ". APS no ack."
    else if (statusCode === 0xf0 || statusCode === 'MAC_TRANSACTION_EXPIRED')   // ZMacTransactionExpired is 8 secs
        ret += ". MAC transaction expired."

    return ret
}

af.send = async function (srcEp, dstEp, cId, rawPayload, opt) {
    // srcEp maybe a local app ep, or a remote ep
    var deferred = Q.defer(),
        controller = af.controller,
        shepherd = controller.getShepherd(),
        coordinator,
        areq = af.areq,
        areqTimeout,
        profId = srcEp.getProfId(),
        afParams,
        afEventCnf,
        apsAck = false,
        senderEp;

    if (!((srcEp instanceof Endpoint) || (srcEp instanceof Coordpoint)))
        throw new TypeError('srcEp should be an instance of Endpoint class.');

    if (_.isString(cId)) {
        var cIdItem = zclId.cluster(cId);
        if (_.isUndefined(cIdItem)) {
            deferred.reject(new Error('Invalid cluster id: ' + cId + '.'));
            return deferred.promise
        } else {
            cId = cIdItem.value;
        }
    }

    if (!_.isBuffer(rawPayload))
        throw new TypeError('Af rawPayload should be a buffer.');

    opt = opt || {};

    if (opt.hasOwnProperty('timeout'))
        proving.number(opt.timeout, 'opt.timeout should be a number.');

    areqTimeout = opt.hasOwnProperty('timeout') ? opt.timeout : af.indirectTimeout;

    coordinator = controller.getCoord()

    if(!coordinator)
        throw new Error("Coordinator is manditory")

    senderEp = srcEp.isLocal() ? srcEp : coordinator.getDelegator(profId);

    if (!senderEp)
        senderEp = srcEp.isLocal() ? srcEp : coordinator.getDelegator(0x0104);

    afParams = makeAfParams(senderEp, dstEp, cId, rawPayload, opt);
    afEventCnf = 'AF:dataConfirm:' + senderEp.getEpId() + ':' + afParams.transid;
    apsAck = afParams.options & ZSC.AF.options.ACK_REQUEST;

    var search = 0
    while (areq.isEventPending(afEventCnf) && search++ < af.maxTransactions) {
        afParams.transid = controller.nextTransId();
        afEventCnf = 'AF:dataConfirm:' + senderEp.getEpId() + ':' + afParams.transid;
    }
    if(search == af.maxTransactions){
        throw new Error("Too many transactions pending")
    }

    var indirecter, lastError

    areq.register(afEventCnf, deferred, function (cnf) {
        var errText = 'AF:dataRequest fails, status code: ';

        if (cnf.status === 0 || cnf.status === 'SUCCESS') {  // success
            if(shepherd){
                shepherd.emit('ind:dataConfirm', dstEp, afParams);
            }
            areq.resolve(afEventCnf, cnf);
        } else {
            lastError = new Error(format_af_error(errText, cnf.status))
            
            if(cnf.status == 183 || cnf.status == 240 || cnf.status == 205){
                indirecter.handleTimeout()
            } else if(cnf.status != 205){
                areq.reject(afEventCnf, lastError)
            }
        }
    }, areqTimeout, false);
    
    indirecter = controller._indirect_send(dstEp.getNwkAddr(), function _sendBasic(){
        controller.request('AF', 'dataRequest', afParams).then(function (rsp) {
            areq.setTimeout(afEventCnf, areqTimeout)
            if (rsp.status !== 0 && rsp.status !== 'SUCCESS' )  // unsuccessful
                areq.reject(afEventCnf, new Error('AF:dataRequest failed, status code: ' + rsp.status + '.'));
            else if (!apsAck)
                areq.resolve(afEventCnf, rsp);
        }).catch(function (err) {
            areq.reject(afEventCnf, err);
        })
    }, deferred.promise)

    return deferred.promise.catch(function(e){
        if(e.code == 'ETIMEDOUT' && lastError){
            throw lastError
        }
        throw e
    })
};

af.sendExt = function (srcEp, addrMode, dstAddrOrGrpId, cId, rawPayload, opt) {
    // srcEp must be a local ep
    var deferred = Q.defer(),
        controller = af.controller,
        areq = af.areq,
        areqTimeout,
        afParamsExt,
        afEventCnf,
        apsAck = false,
        senderEp = srcEp;

    if (!((srcEp instanceof Endpoint) || (srcEp instanceof Coordpoint)))
        throw new TypeError('srcEp should be an instance of Endpoint class.');

    proving.number(addrMode, 'Af addrMode should be a number.');

    if (addrMode === ZSC.AF.addressMode.ADDR_16BIT || addrMode === ZSC.AF.addressMode.ADDR_GROUP)
        proving.number(dstAddrOrGrpId, 'Af dstAddrOrGrpId should be a number for netwrok address or group id.');
    else if (addrMode === ZSC.AF.addressMode.ADDR_64BIT)
        proving.string(dstAddrOrGrpId, 'Af dstAddrOrGrpId should be a string for long address.');

    if (_.isString(cId)) {
        var cIdItem = zclId.cluster(cId);
        if (_.isUndefined(cIdItem)) {
            deferred.reject(new Error('Invalid cluster id: ' + cId + '.'));
            return deferred.promise
        } else {
            cId = cIdItem.value;
        }
    }

    if (!_.isBuffer(rawPayload))
        throw new TypeError('Af rawPayload should be a buffer.');

    opt = opt || {};

    if (opt.hasOwnProperty('timeout'))
        proving.number(opt.timeout, 'opt.timeout should be a number.');

    areqTimeout = opt.hasOwnProperty('timeout') ? opt.timeout : undefined;

    if (!senderEp.isLocal()) {
        deferred.reject(new Error('Only a local endpoint can groupcast, broadcast, and send extend message.'));
        return deferred.promise
    }

    afParamsExt = makeAfParamsExt(senderEp, addrMode, dstAddrOrGrpId, cId, rawPayload, opt);

    if (!afParamsExt) {
        deferred.reject(new Error('Unknown address mode. Cannot send.'));
        return deferred.promise
    }

    var indirecter, lastError

    if (addrMode === ZSC.AF.addressMode.ADDR_GROUP || addrMode === ZSC.AF.addressMode.ADDR_BROADCAST) {
        // no ack
        indirecter = controller._indirect_send(dstAddrOrGrpId, function _sendExt(){
            controller.request('AF', 'dataRequestExt', afParamsExt).then(function (rsp) {
                if (rsp.status !== 0 && rsp.status !== 'SUCCESS')   // unsuccessful
                    deferred.reject(new Error('AF:dataExtend request failed, status code: ' + rsp.status + '.'));
                else
                    deferred.resolve(rsp);  // Broadcast (or Groupcast) has no AREQ confirm back, just resolve this transaction.
            }).catch(function (err) {
                deferred.reject(err);
            })
        }, deferred.promise)
    } else {
        afEventCnf = 'AF:dataConfirm:' + senderEp.getEpId() + ':' + afParamsExt.transid;
        apsAck = afParamsExt.options & ZSC.AF.options.ACK_REQUEST;

        var search = 0
        while (areq.isEventPending(afEventCnf) && search++ < af.maxTransactions) {
            afParamsExt.transid = controller.nextTransId();
            afEventCnf = 'AF:dataConfirm:' + senderEp.getEpId() + ':' + afParamsExt.transid;
        }
        if(search == af.maxTransactions){
            throw new Error("Too many transactions pending")
        }

        areq.register(afEventCnf, deferred, function (cnf) {
            var errText = 'AF:dataRequest fails, status code: ';
            if (cnf.status === 0 || cnf.status === 'SUCCESS') {  // success
                areq.resolve(afEventCnf, cnf);
            } else {
                lastError = new Error(format_af_error(errText, cnf.status))

                if(cnf.status == 183 || cnf.status == 240){
                    indirecter.handleTimeout()
                } else if(cnf.status != 205){
                    areq.reject(afEventCnf, lastError)
                }
            }
        }, areqTimeout, false);

        indirecter = controller._indirect_send(dstAddrOrGrpId, function _sendExt(){
            controller.request('AF', 'dataRequestExt', afParamsExt).then(function (rsp) {
                areq.setTimeout(afEventCnf, areqTimeout)
                if (rsp.status !== 0 && rsp.status !== 'SUCCESS')   // unsuccessful
                    areq.reject(afEventCnf, new Error('AF:dataRequestExt failed, status code: ' + rsp.status + '.'));
                else if (!apsAck)
                    areq.resolve(afEventCnf, rsp);
            }).catch(function (err) {
                areq.reject(afEventCnf, err);
            })
        }, deferred.promise)
    }
    
    return deferred.promise.catch(function(e){
        if(e.code == 'ETIMEDOUT' && lastError){
            throw lastError
        }
        throw e
    })
};

af.zclFoundation = function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    var deferred = Q.defer(),
        areq = af.areq,
        dir = (srcEp === dstEp) ? 0 : 1,    // 0: client-to-server, 1: server-to-client
        manufCode = 0,
        frameCntl,
        seqNum,
        zclBuffer,
        mandatoryEvent;

        cfg = cfg || {};

    proving.stringOrNumber(cmd, 'cmd should be a number or a string.');
    proving.object(cfg, 'cfg should be a plain object if given.');

    frameCntl = {
        frameType: 0,       // command acts across the entire profile (foundation)
        manufSpec: cfg.hasOwnProperty('manufSpec') ? cfg.manufSpec : 0,
        direction: cfg.hasOwnProperty('direction') ? cfg.direction : dir,
        disDefaultRsp: cfg.hasOwnProperty('disDefaultRsp') ? cfg.disDefaultRsp : 0  // enable deafult response command
    };

    if (frameCntl.manufSpec === 1)
        manufCode = dstEp.getManufCode();

    // .frame(frameCntl, manufCode, seqNum, cmd, zclPayload[, clusterId])
    seqNum = cfg.hasOwnProperty('seqNum') ? cfg.seqNum : nextZclSeqNum();

    try {
        zclBuffer = zcl.frame(frameCntl, manufCode, seqNum, cmd, zclData);
    } catch (e) {
        if (e.message === 'Unrecognized command') {
            deferred.reject(e);
            return deferred.promise;
        } else {
            throw e;
        }
    }

    if (frameCntl.direction === 0) {    // client-to-server, thus require getting the feedback response

        if (srcEp === dstEp)    // from remote to remote itself
            mandatoryEvent = 'ZCL:incomingMsg:' + dstEp.getNwkAddr() + ':' + dstEp.getEpId() + ':' + seqNum;
        else                    // from local ep to remote ep
            mandatoryEvent = 'ZCL:incomingMsg:' + dstEp.getNwkAddr() + ':' + dstEp.getEpId() + ':' + srcEp.getEpId() + ':' + seqNum;

        areq.register(mandatoryEvent, deferred, function (msg) {
            // { groupid, clusterid, srcaddr, srcendpoint, dstendpoint, wasbroadcast, linkquality, securityuse, timestamp, transseqnumber, zclMsg }
            areq.resolve(mandatoryEvent, msg.zclMsg);
        });
    }

    var afOptions = cfg.hasOwnProperty('afOptions') ? cfg.afOptions : {}

    af.send(srcEp, dstEp, cId, zclBuffer, afOptions).catch(function (err) {
        if (mandatoryEvent && areq.isEventPending(mandatoryEvent))
            areq.reject(mandatoryEvent, err);
        else
            deferred.reject(err);
    }).then(function (rsp) {
        if (!mandatoryEvent)
            deferred.resolve(rsp);
    });

    return deferred.promise.catch((err)=>{
        if(err.code == "ETIMEDOUT"){
            err.message = "zclFoundation("+cmd+":"+seqNum+") " + err.message
        }
        throw err
    })
};

af.zclFunctional = function (srcEp, dstEp, cId, cmd, zclData, cfg) {
    var deferred = Q.defer(),
        areq = af.areq,
        dir = (srcEp === dstEp) ? 0 : 1,    // 0: client-to-server, 1: server-to-client
        manufCode = 0,
        seqNum,
        frameCntl,
        zclBuffer,
        mandatoryEvent;

    if (!((srcEp instanceof Endpoint) || (srcEp instanceof Coordpoint)))
        throw new TypeError('srcEp should be an instance of Endpoint class.');

    if (!((dstEp instanceof Endpoint) || (dstEp instanceof Coordpoint)))
        throw new TypeError('dstEp should be an instance of Endpoint class.');

    if (typeof zclData !== 'object' || zclData === null)
        throw new TypeError('zclData should be an object or an array');

    proving.stringOrNumber(cId, 'cId should be a number or a string.');
    proving.stringOrNumber(cmd, 'cmd should be a number or a string.');
    proving.object(cfg, 'cfg should be a plain object if given.');

    frameCntl = {
        frameType: 1,       // functional command frame
        manufSpec: cfg.hasOwnProperty('manufSpec') ? cfg.manufSpec : 0,
        direction: cfg.hasOwnProperty('direction') ? cfg.direction : dir,
        disDefaultRsp: cfg.hasOwnProperty('disDefaultRsp') ? cfg.disDefaultRsp : 0  // enable deafult response command
    };

    if (frameCntl.manufSpec === 1)
        manufCode = dstEp.getManufCode();

    // .frame(frameCntl, manufCode, seqNum, cmd, zclPayload[, clusterId])
    seqNum = cfg.hasOwnProperty('seqNum') ? cfg.seqNum : nextZclSeqNum();

    try {
        zclBuffer = zcl.frame(frameCntl, manufCode, seqNum, cmd, zclData, cId);
    } catch (e) {
        if (e.message === 'Unrecognized command' || e.message === 'Unrecognized cluster') {
            deferred.reject(e);
            return deferred.promise
        } else {
            deferred.reject(e);
            return deferred.promise
        }
    }

    if (frameCntl.direction === 0) {    // client-to-server, thus require getting the feedback response

        if (srcEp === dstEp)    // from remote to remote itself
            mandatoryEvent = 'ZCL:incomingMsg:' + dstEp.getNwkAddr() + ':' + dstEp.getEpId() + ':' + seqNum;
        else                    // from local ep to remote ep
            mandatoryEvent = 'ZCL:incomingMsg:' + dstEp.getNwkAddr() + ':' + dstEp.getEpId() + ':' + srcEp.getEpId() + ':' + seqNum;
        
        areq.register(mandatoryEvent, deferred, function (msg) {
            // { groupid, clusterid, srcaddr, srcendpoint, dstendpoint, wasbroadcast, linkquality, securityuse, timestamp, transseqnumber, zclMsg }
            areq.resolve(mandatoryEvent, msg.zclMsg);
        });
    }

    var afOptions = cfg.hasOwnProperty('afOptions') ? cfg.afOptions : {}

    // af.send(srcEp, dstEp, cId, rawPayload, opt)
    af.send(srcEp, dstEp, cId, zclBuffer, afOptions).catch(function (err) {
        if (mandatoryEvent && areq.isEventPending(mandatoryEvent))
            areq.reject(mandatoryEvent, err);
        else
            deferred.reject(err);
    }).then(function (rsp) {
        if (!mandatoryEvent)
            deferred.resolve(rsp);
    });

    return deferred.promise.catch((err)=>{
        if(err.code == "ETIMEDOUT"){
            err.message = "zclFunctional("+cmd+":"+seqNum+") " + err.message
        }
        throw err
    })
};

/*************************************************************************************************/
/*** ZCL Cluster and Attribute Requests                                                        ***/
/*************************************************************************************************/
af.zclClustersReq = function (dstEp, eventEmitter, interested, callback) {    // callback(err, clusters)
// clusters: {
//    genBasic: { dir: 1, attrs: { x1: 0, x2: 3, ... } },   // dir => 0: 'unknown', 1: 'in', 2: 'out'
//    fooClstr: { dir: 1, attrs: { x1: 0, x2: 3, ... } },
//    ...
// }

    var epId;
    try {
        epId = dstEp.getEpId();
    } catch (err){
        epId = null;
    }

    // If event emitter is function, consider it callback (legacy)
    if (typeof eventEmitter === 'function') {
        callback = eventEmitter;
        eventEmitter = undefined
    }
    else if (typeof interested === 'function') {
        callback = interested;
        interested = undefined
    }

    var clusters = {},
        clusterList = dstEp.getClusterList(),       // [ 1, 2, 3, 4, 5 ]
        inClusterList = dstEp.getInClusterList(),   // [ 1, 2, 3 ]
        outClusterList = dstEp.getOutClusterList(); // [ 1, 3, 4, 5 ]
        // clusterAttrsRsps = [];  // { attr1: x }, ...

    var i = 0;
    var error

    clusterList = filterInterestedCluster(clusterList)
    var totalLength = clusterList.length

    function cIdToString(cId){
        var cIdString = zclId.cluster(cId);
        return cIdString ? cIdString.key : cId;
    }

    function mappingFunc (cId) {
        var cIdString = cIdToString(cId)

        function handleAttributes (attrs, error) {
            i++;
            if (eventEmitter instanceof EventEmitter && !error) {
                eventEmitter.emit('ind:interview', {
                    endpoint: {
                        current: epId,
                        cluster: {
                            total: totalLength,
                            current: i,
                            id: cId,
                            attrs: attrs,
                            error: error
                        }
                    }
                });
            }

			if(typeof clusters[cIdString] == "undefined"){
                clusters[cIdString] = {}
            }
            clusters[cIdString].i = i;
			clusters[cIdString].dir = _.includes(inClusterList, cId) ? (clusters[cIdString].dir | 0x01) : clusters[cIdString].dir;
			clusters[cIdString].dir = _.includes(outClusterList, cId) ? (clusters[cIdString].dir | 0x02) : clusters[cIdString].dir;
            clusters[cIdString].attrs = attrs;
            clusters[cIdString].id = cId;
            if(error) clusters[cIdString].error = error.toString();
		};

		return af.zclClusterAttrsReq(dstEp, cId, valueInterestedCluster(cId)).then(handleAttributes).catch(function(err){
            debug("An error occured when scanning ep: " + err);
            error = err
            handleAttributes({}, err);
		});
    };

    function filterInterestedCluster(clusterList){
        if(interested === true || typeof interested === "undefined") return clusterList
        var ret = []
        for(var i in clusterList){
            var cId = cIdToString(clusterList[i])
            var cInterest = interested[cId]
            if(typeof cInterest === "undefined") continue
            ret.push(cId)
        }
        return ret
    }

    function valueInterestedCluster(clusterId){
        if(interested === true || typeof interested === "undefined") return true
        if(interested[cIdToString(clusterId)]) return true
        return false
    }

    if(!clusterList.length){
        return Q(clusters) /* empty */
    }

    var first = clusterList.shift()
    
	return mappingFunc(first)
        .then(function(){
            return Q.all(clusterList.map(mappingFunc))
        })
        .then(function(){
            var completedAny, remainingErrors, itCount = 0
            function buildSlowChain(){
                completedAny = remainingErrors = false
                var slowChain = Q(0)
                _.forEach(clusters, function(cluster, cId){
                    if(cluster.error){
                        slowChain = slowChain.then(function(){
                            return af.zclClusterAttrsReq(dstEp, cluster.id, valueInterestedCluster(cId)).then(function(attrs){
                                cluster.attrs = attrs
                                cluster.error = undefined
                                completedAny = true
                            }, function(err){
                                cluster.error = err
                                remainingErrors = true
                            }).then(function(){
                                if (!cluster.error && eventEmitter instanceof EventEmitter) {
                                    eventEmitter.emit('ind:interview', {
                                        endpoint: {
                                            current: epId,
                                            cluster: {
                                                total: totalLength,
                                                current: cluster.i,
                                                id: cluster.id,
                                                attrs: cluster.attrs,
                                                error: cluster.error
                                            }
                                        }
                                    });
                                }
                            })
                        })
                    }
                })
                return slowChain
            }
            function recursiveSlowChain(){
                itCount ++
                debug("Executing slow chain iteration %d for %s", itCount, dstEp.getIeeeAddr())
                return buildSlowChain().then(function(){
                    if(completedAny && remainingErrors){
                        return recursiveSlowChain()
                    }else{
                        /* Give up */
                        _.forEach(clusters, function(cluster, cIdString){
                            if(cluster.error){
                                if (eventEmitter instanceof EventEmitter) {
                                    eventEmitter.emit('ind:interview', {
                                        endpoint: {
                                            current: epId,
                                            cluster: {
                                                total: totalLength,
                                                current: cluster.i,
                                                id: cluster.id,
                                                attrs: cluster.attrs,
                                                error: cluster.error
                                            }
                                        }
                                    });
                                }
                            }
                        })
                    }
                })
            }
            return recursiveSlowChain()
        })
        .then(function () {
            if(clusters.genBasic && Object.keys(clusters.genBasic.attrs).length == 0){
                throw new Error("Unable to read genBasic, likely communication error");
            }
            return clusters
        })
};

af.zclClusterAttrsReq = async function (dstEp, cId, interestedValue) {
    return await af._zclClusterAttrsReq(dstEp, cId, interestedValue, af.controller.limitConcurrency)
}
af._zclClusterAttrsReq = async function (dstEp, cId, interestedValue, limit) {
    if (!((dstEp instanceof Endpoint) || (dstEp instanceof Coordpoint)))
        throw new TypeError('dstEp should be an instance of Endpoint class.');
        
    proving.stringOrNumber(cId, 'cId should be a number or a string.');

    if(!limit){
        limit = fn=>fn()
    }

    const attrIds = await limit(()=>af.zclClusterAttrIdsReq(dstEp, cId), dstEp.getIeeeAddr())(true)
    var attributes = []
    if(interestedValue === false){
        for(var i = 0; i<attrIds.length; i++){
            attributes.push({
                attrId:attrIds[i],
                attrData: null
            })
        }
        return attributes
    }
    
    var readReq = [],
        attrsReqs = [],
        attrIdsLen = attrIds.length;

    _.forEach(attrIds, function (id) {
        readReq.push({ attrId: id });

        if (readReq.length === 5 || readReq.length === attrIdsLen) {
            var req = _.cloneDeep(readReq);
            attrsReqs.push(function () {
                /* Process in groups of 5 */
                return limit(()=>af.zclFoundation(dstEp, dstEp, cId, 'read', req), dstEp.getIeeeAddr())(true)
                    .then(
                        function (readStatusRecsRsp) {
                            Array.prototype.push.apply(attributes,readStatusRecsRsp.payload);
                        },
                        function(){
                            /* A failure occured - process in single reads */
                            debug("Failed to read chunk, processing individually")

                            var singleChain = Q(0)
                            req.forEach(function(r){
                                singleChain = singleChain.then(function(){
                                    return limit(()=>af.zclFoundation(dstEp, dstEp, cId, 'read', [r]), dstEp.getIeeeAddr())(true)
                                        .then(function (readStatusRecsRsp) {
                                            Array.prototype.push.apply(attributes,readStatusRecsRsp.payload);
                                        },(err)=>{
                                            debug("An error occured when reading cluster: %s attr: %s. Error: %s", cId, r.attrId, err);
                                            error = err
                                        });
                                });
                            })
                            return singleChain						
                        }
                    );
            });
            attrIdsLen -= 5;
            readReq = [];
        }
    });

    await Q.all(attrsReqs.map(c=>Q.fcall(c)))
    
    var attrs = {};
    _.forEach(attributes, function (rec) {  // { attrId, status, dataType, attrData }
        var attrIdString = zclId.attr(cId, rec.attrId);

        attrIdString = attrIdString ? attrIdString.key : rec.attrId;

        attrs[attrIdString] = null;

        if (rec.status === 0)
            attrs[attrIdString] = rec.attrData;
                

        return attrs;
    })
};

af.zclClusterAttrIdsReq = function (dstEp, cId) {
    var deferred = Q.defer(),
        attrsToRead = [];

    if (!((dstEp instanceof Endpoint) || (dstEp instanceof Coordpoint)))
        throw new TypeError('dstEp should be an instance of Endpoint class.');
        
    proving.stringOrNumber(cId, 'cId should be a number or a string.');

    function discAttrs (startAttrId, defer) {
        af.zclFoundation(dstEp, dstEp, cId, 'discover', {
            startAttrId: startAttrId,
            maxAttrIds: 240
        }).then(function (discoverRsp) {
            // discoverRsp.payload: { discComplete, attrInfos: [ { attrId, dataType }, ... ] }
            var payload = discoverRsp.payload,
                discComplete = payload.discComplete,
                attrInfos = payload.attrInfos,
                nextReqIndex;

            _.forEach(attrInfos, function (info) {
                if (_.indexOf(attrsToRead, info.attrId) === -1)
                    attrsToRead.push(info.attrId);
            });

            if (discComplete === 0) {
                nextReqIndex = attrInfos[attrInfos.length - 1].attrId + 1;
                discAttrs(nextReqIndex, defer);
            } else {
                defer.resolve(attrsToRead);
            }
        }).catch(function (err) {
            defer.reject(err);
        });
    };

    discAttrs(0, deferred);

    return deferred.promise
};

/*************************************************************************************************/
/*** Private Functions: Message Dispatcher                                                     ***/
/*************************************************************************************************/
// 4 types of message: dataConfirm, reflectError, incomingMsg, incomingMsgExt, zclIncomingMsg
function dispatchIncomingMsg(type, msg) {
    var targetEp,       // remote ep, or a local ep (maybe a delegator)
        remoteEp,
        dispatchTo,     // which callback on targetEp
        zclHeader,
        frameType,      // check whether the msg is foundation(0) or functional(1)
        mandatoryEvent; // bridged event
        
	var coord = af.controller.getCoord()
		
    if (msg.hasOwnProperty('endpoint')) {                                               // dataConfirm, reflectError
		if(!coord) return;
        targetEp = coord.getEndpoint(msg.endpoint);                  //  => find local ep, such a message is going to local ep
    } else if (msg.hasOwnProperty('srcaddr') && msg.hasOwnProperty('srcendpoint')) {    // incomingMsg, incomingMsgExt, zclIncomingMsg
		if(!coord) return;
        targetEp = coord.getEndpoint(msg.dstendpoint);               //  => find local ep

        if (targetEp) {  // local
            remoteEp = af.controller.findEndpoint(msg.srcaddr, msg.srcendpoint);

            if (targetEp.isDelegator()) {  // delegator, pass message to remote endpoint
                targetEp = remoteEp;
            } else if (!remoteEp) {        // local zApp not found, get ieeeaddr and emit fake 'endDeviceAnnceInd' msg
                var msgBuffer = rebornDevs[msg.srcaddr];

                if (_.isArray(msgBuffer)) {
                    msgBuffer.push({ type: type, msg: msg });
                } else if (_.isUndefined(msgBuffer)) {
                    msgBuffer = rebornDevs[msg.srcaddr] = [ { type: type, msg: msg } ];

                    af.controller.request('ZDO', 'ieeeAddrReq', { shortaddr: msg.srcaddr, reqtype: 0, startindex:0 }).then(function (rsp) {
                        // rsp: { status, ieeeaddr, nwkaddr, startindex, numassocdev, assocdevlist }
                        af.controller.once('ind:incoming:' + rsp.ieeeaddr, function () {
                            if (af.controller.findEndpoint(msg.srcaddr, msg.srcendpoint) && _.isArray(msgBuffer))
                                _.forEach(msgBuffer, function(item) {
                                    dispatchIncomingMsg(item.type, item.msg);
                                });
                            else
                                delete rebornDevs[msg.srcaddr];
                        });
                        af.controller.emit('ZDO:endDeviceAnnceInd', { srcaddr: rsp.nwkaddr, nwkaddr: rsp.nwkaddr, ieeeaddr: rsp.ieeeaddr });
                    }).catch(function (err) {
                        delete rebornDevs[msg.srcaddr];
                    });
                }

                return;
            }
        }
    }

    if (!targetEp)      // if target not found, ignore this message
        return;

    switch (type) {
        case 'dataConfirm':
            // msg: { status, endpoint, transid }
            mandatoryEvent = 'AF:dataConfirm:' + msg.endpoint + ':' + msg.transid;  // sender(loEp) is listening, see af.send() and af.sendExt()
            dispatchTo = targetEp.onAfDataConfirm;
            break;
        case 'reflectError':
            // msg: { status, endpoint, transid, dstaddrmode, dstaddr }
            mandatoryEvent = 'AF:reflectError:' + msg.endpoint + ':' + msg.transid;
            dispatchTo = targetEp.onAfReflectError;
            break;
        case 'incomingMsg':
            // msg: { groupid, clusterid, srcaddr, srcendpoint, dstendpoint, wasbroadcast, linkquality, securityuse, timestamp, transseqnumber, len, data }
            zclHeader = zcl.header(msg.data);       // a zcl packet maybe, pre-parse it to get the header
            dispatchTo = targetEp.onAfIncomingMsg;
            break;
        case 'incomingMsgExt':
            // msg: { groupid, clusterid, srcaddr, srcendpoint, dstendpoint, wasbroadcast, linkquality, securityuse, timestamp, transseqnumber, len, data }
            zclHeader = zcl.header(msg.data);       // a zcl packet maybe, pre-parse it to get the header
            dispatchTo = targetEp.onAfIncomingMsgExt;
            break;
        case 'zclIncomingMsg':
            // msg.data is now msg.zclMsg
            frameType = msg.zclMsg.frameCntl.frameType;

            // { groupid, clusterid, srcaddr, srcendpoint, dstendpoint, wasbroadcast, linkquality, securityuse, timestamp, transseqnumber, zclMsg }
            if (targetEp.isLocal()) {
                // to local app ep, receive zcl command or zcl command response. see af.zclFoudation() and af.zclFunctional()
                if (!targetEp.isDelegator())
                    mandatoryEvent = 'ZCL:incomingMsg:' + msg.srcaddr + ':' + msg.srcendpoint + ':' + msg.dstendpoint + ':' + msg.zclMsg.seqNum;
            } else {
                var localEp = af.controller.findEndpoint(0, msg.dstendpoint),
                    toLocalApp = false;

                if (localEp)
                    toLocalApp = localEp.isLocal() ? !localEp.isDelegator() : false;

                if (toLocalApp) {
                    mandatoryEvent = 'ZCL:incomingMsg:' + msg.srcaddr + ':' + msg.srcendpoint + ':' + msg.dstendpoint + ':' + msg.zclMsg.seqNum;
                } else {
                    // to remote ep, receive the zcl command response
                    mandatoryEvent = 'ZCL:incomingMsg:' + msg.srcaddr + ':' + msg.srcendpoint + ':' + msg.zclMsg.seqNum;

                    // Necessary, some IAS devices don't respect endpoints
                    if(msg.zclMsg.cmdId === 'statusChangeNotification' && frameType === 1 && msg.zclMsg.payload){   
                        af.controller.getShepherd().emit('ind:statusChange', targetEp, msg.clusterid, msg.zclMsg.payload, msg);
                    } 
                }
            }
                         
            if (frameType === 0 && msg.zclMsg.cmdId === 'report')
                af.controller.getShepherd().emit('ind:reported', targetEp, msg.clusterid, msg.zclMsg.payload);

            if (frameType === 0)         // foundation
                dispatchTo = targetEp.onZclFoundation;
            else if (frameType === 1)    // functional
                dispatchTo = targetEp.onZclFunctional;
            break;
    }

    if (_.isFunction(dispatchTo)) {
        setImmediate(function () {
            dispatchTo(msg, remoteEp);
        });
    }

    if (mandatoryEvent)
        af.controller.emit(mandatoryEvent, msg);

    if (type === 'zclIncomingMsg')  // no need for further parsing
        return;

    // further parse for ZCL packet from incomingMsg and incomingMsgExt
    if (zclHeader) {  // if (zclHeader && targetEp.isZclSupported()) {
        function zclIncomingParsedMsgEmitter (err, zclData) {
            if (!err) {
                var parsedMsg = _.cloneDeep(msg);
                parsedMsg.zclMsg = zclData;

                af.controller.emit('ZCL:incomingMsg', parsedMsg);
            }
        }

         // after zcl packet parsed, re-emit it
        if (zclHeader.frameCntl.frameType === 0) {          // foundation
            zcl.parse(msg.data, zclIncomingParsedMsgEmitter);
        } else if (zclHeader.frameCntl.frameType === 1) {   // functional
            zcl.parse(msg.data, msg.clusterid, zclIncomingParsedMsgEmitter);
        }
    }
}

/*************************************************************************************************/
/*** Private Functions                                                                         ***/
/*************************************************************************************************/

function makeAfParams(loEp, dstEp, cId, rawPayload, opt) {
    opt = opt || {};    // opt = { options, radius }

    proving.number(cId, 'cId should be a number.');

    if (opt.hasOwnProperty('options'))
        proving.number(opt.options, 'opt.options should be a number.');

    if (opt.hasOwnProperty('radius'))
        proving.number(opt.radius, 'opt.radius should be a number.');

    var afOptions = ZSC.AF.options.ACK_REQUEST | ZSC.AF.options.DISCV_ROUTE,    // ACK_REQUEST (0x10), DISCV_ROUTE (0x20)
        afParams = {
            dstaddr: dstEp.getNwkAddr(),
            destendpoint: dstEp.getEpId(),
            srcendpoint: loEp.getEpId(),
            clusterid: cId,
            transid: af.controller ? af.controller.nextTransId() : null,
            options: opt.hasOwnProperty('options') ? opt.options : afOptions,
            radius: opt.hasOwnProperty('radius') ? opt.radius : ZSC.AF_DEFAULT_RADIUS,
            len: rawPayload.length,
            data: rawPayload
        };

    return afParams;
}

function makeAfParamsExt(loEp, addrMode, dstAddrOrGrpId, cId, rawPayload, opt) {
    opt = opt || {};    // opt = { options, radius, dstEpId, dstPanId }

    proving.number(cId, 'cId should be a number.');

    proving.defined(loEp, 'loEp should be defined');

    if (opt.hasOwnProperty('options'))
        proving.number(opt.options, 'opt.options should be a number.');

    if (opt.hasOwnProperty('radius'))
        proving.number(opt.radius, 'opt.radius should be a number.');

    var afOptions = ZSC.AF.options.DISCV_ROUTE,
        afParamsExt = {
            dstaddrmode: addrMode,
            dstaddr: zutils.toLongAddrString(dstAddrOrGrpId),
            destendpoint: 0xFF,
            dstpanid: opt.hasOwnProperty('dstPanId') ? opt.dstPanId : 0,
            srcendpoint: loEp.getEpId(),
            clusterid: cId,
            transid: af.controller ? af.controller.nextTransId() : null,
            options: opt.hasOwnProperty('options') ? opt.options : afOptions,
            radius: opt.hasOwnProperty('radius') ? opt.radius : ZSC.AF_DEFAULT_RADIUS,
            len: rawPayload.length,
            data: rawPayload
        };

    switch (addrMode) {
        case ZSC.AF.addressMode.ADDR_NOT_PRESENT:
            break;
        case ZSC.AF.addressMode.ADDR_GROUP:
            afParamsExt.destendpoint = 0xFF;
            break;
        case ZSC.AF.addressMode.ADDR_16BIT:
        case ZSC.AF.addressMode.ADDR_64BIT:
            afParamsExt.destendpoint = opt.hasOwnProperty('dstEpId') ? opt.dstEpId : 0xFF;
            afParamsExt.options = opt.hasOwnProperty('options') ? opt.options : afOptions | ZSC.AF.options.ACK_REQUEST;
            break;
        case ZSC.AF.addressMode.ADDR_BROADCAST:
            afParamsExt.destendpoint = 0xFF;
            afParamsExt.dstaddr = zutils.toLongAddrString(0xFFFF);
            break;
        default:
            afParamsExt = null;
            break;
    }

    return afParamsExt;
}

function nextZclSeqNum() {
    seqNumber += 1; // seqNumber is a private var on the top of this module
    if (seqNumber > 255 || seqNumber < 0 )
        seqNumber = 0;

    af._seq = seqNumber;
    return seqNumber;
}

function dataConfirmHandler(msg) {
    return dispatchIncomingMsg('dataConfirm', msg);
}

function reflectErrorHandler(msg) {
    return dispatchIncomingMsg('reflectError', msg);
}

function incomingMsgHandler(msg) {
    return dispatchIncomingMsg('incomingMsg', msg);
}

function incomingMsgExtHandler(msg) {
    return dispatchIncomingMsg('incomingMsgExt', msg);
}

function zclIncomingMsgHandler(msg) {
    return dispatchIncomingMsg('zclIncomingMsg', msg);
}

/*************************************************************************************************/
/*** module.exports                                                                            ***/
/*************************************************************************************************/
module.exports = function (controller) {
    if (!(controller instanceof EventEmitter))
        throw new TypeError('Controller should be an EventEmitter.');

    var msgHandlers = [
        { evt: 'AF:dataConfirm', hdlr: dataConfirmHandler },
        { evt: 'AF:reflectError', hdlr: reflectErrorHandler },
        { evt: 'AF:incomingMsg', hdlr: incomingMsgHandler },
        { evt: 'AF:incomingMsgExt', hdlr: incomingMsgExtHandler },
        { evt: 'ZCL:incomingMsg', hdlr: zclIncomingMsgHandler }
    ];

    af.controller = controller;
    af.areq = new Areq(controller, 60000);

    // attach event listeners
    _.forEach(msgHandlers, function (rec) {
        af.controller.removeListener(rec.evt, rec.hdlr)
        af.controller.on(rec.evt, rec.hdlr);
    });

    return af;
};
