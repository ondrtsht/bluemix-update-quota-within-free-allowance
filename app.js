
if (process.argv.length < 4) {
    console.log("Usage: " + __filename + " username password");
    process.exit(-1);
}
const http = require('http');
const https = require('https');
const url = require('url');
const querystring = require('querystring');

let apiEndpoint = 'https://api.ng.bluemix.net';
let apiEndpointUrl = url.parse(apiEndpoint);

let username = process.argv[2];
let password = process.argv[3];
 
let info = {};
let token = {};
let accounts = {};
let tokenType = '';
let accessToken = '';
let usage = {};
let customerId = '';
let spaceQuotaDefinitions = {};
let spaceQuotaDefinitionsUpdated = {};
let spaceQuotaCandidate = {}; // key = name, value = memoryLimit (MB)

let today = new Date();
let cstToday = new Date();
cstToday.setHours(today.getHours() - 6 + today.getTimezoneOffset() / 60);
console.log('JST (+9): ' + today.toString());
console.log('CST (-6): ' + cstToday.toString());

let targetMonth = `${cstToday.getFullYear()}-${('0' + (cstToday.getMonth() + 1)).slice(-2)}`;
let periodEndDate = new Date(cstToday.getFullYear(), cstToday.getMonth() + 1, 0, 23, 59, 59);

let numOfDays = periodEndDate.getDate();
let hoursRemain = (periodEndDate.getTime() - cstToday.getTime()) / 1000 / 60 / 60;
console.log(Math.floor(hoursRemain) + " hours remain");
console.log(Math.floor((hoursRemain / 24)) + " days remain");

Promise.resolve()
    .then(function () {
        // request authorization_endpoint (UAA Service)
        return httpsGetPromise(`${apiEndpoint}/info`);
    }).then(function (responseBody) {
        // get authorization_endpoint
        info = JSON.parse(responseBody);
        let authUrl = url.parse(info['authorization_endpoint']);

        // request access token (authentication)
        // https://docs.cloudfoundry.org/api/uaa/#password-grant
        const postData = querystring.stringify({
            'response_type': 'token',
            'grant_type': 'password',
            'username': username,
            'password': password
        });

        let options = {
            protocol: authUrl.protocol,
            hostname: authUrl.hostname,
            path: authUrl.path + '/oauth/token',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic Y2Y6',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        return httpsRequestPromise(options, postData);
    }).then(function (responseBody) {
        // get access token
        token = JSON.parse(responseBody);
        tokenType = token['token_type'];
        accessToken = token['access_token'];

        // request account list to get my customer_id
        // based on the behavior of Bluemix CLI "bx iam accounts"
        let requestUrl = url.parse(`https://accountmanagement.ng.bluemix.net/coe/v2/accounts`);
        let options = {
            protocol: requestUrl.protocol,
            hostname: requestUrl.hostname,
            path: requestUrl.path,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `${tokenType} ${accessToken}`
            }
        };

        return httpsGetPromise(options);
    }).then(function (responseBody) {
        accounts = JSON.parse(responseBody);

        let promises = [];
        accounts['resources'].forEach(function (resource) {
            let ownerUserId = resource['entity']['owner_userid'];
            if (ownerUserId != username) {
                return;
            }

            // request usage
            // based on the behavior of Bluemix CLI "bx billing account-usage"
            customerId = resource['entity']['customer_id'];
            let requestUrl = url.parse(`https://rated-usage.ng.bluemix.net/v2/metering/accounts/${customerId}/usage/${targetMonth}`);
            let options = {
                protocol: requestUrl.protocol,
                hostname: requestUrl.hostname,
                path: requestUrl.path,
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `${tokenType} ${accessToken}`
                }
            };
            let p = httpsGetPromise(options, function (responseBody) {
                usage[customerId] = JSON.parse(responseBody);
                usage[customerId]['billable_usage']['runtimes'].forEach(function (runtime) {
                    let name = runtime['name'];
                    let quantity = 0;
                    if ('plans' in runtime) {
                        runtime['plans'].forEach(function (plan) {
                            if ('usage' in plan) {
                                plan['usage'].forEach(function (usage) {
                                    quantity += usage['quantity'];
                                });
                            }
                        });
                    }
                    let freeAllowanceRemain = 375 - quantity; // GB
                    let quota = freeAllowanceRemain / hoursRemain * 1024; // MB
                    spaceQuotaCandidate[name] = quota;
                    console.log(`${name}: ${quantity.toFixed(2)} GB / ${Math.floor(quota)} MB (${Math.floor(quota / 128) * 128} MB)`);
                });
            });
            promises.push(p);
        });
        return Promise.all(promises);
    }).then(function () {
        // request space_quota_definitions
        let requestUrl = url.parse(`${apiEndpoint}/v2/space_quota_definitions`);
        let options = {
            protocol: requestUrl.protocol,
            hostname: requestUrl.hostname,
            path: requestUrl.path,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `${tokenType} ${accessToken}`
            }
        };
        return httpsGetPromise(options);
    }).then(function (responseBody) {
        // get space_quota_definitions
        spaceQuotaDefinitions = JSON.parse(responseBody);
        //        console.log(JSON.stringify(spaceQuotaCandidate, null, 2));
        //        console.log(JSON.stringify(spaceQuotaDefinitions, null, 2));

        // update memory_limit of space quotas named with runtime name
        let promises = [];
        spaceQuotaDefinitions['resources'].forEach(function (resource) {
            let name = resource['entity']['name'];
            let memoryLimit = resource['entity']['memory_limit'];

            let updateProcs = [];
            if (name in spaceQuotaCandidate) {
                const postData = `{"memory_limit":${Math.floor(spaceQuotaCandidate[name])}}`;
                let options = {
                    protocol: apiEndpointUrl.protocol,
                    hostname: apiEndpointUrl.hostname,
                    path: resource['metadata']['url'],
                    method: 'PUT',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Authorization': `${tokenType} ${accessToken}`,
                        'Content-Length': Buffer.byteLength(postData)
                    }
                };

                let p = httpsRequestPromise(options, postData, function (responseBody) {
                    spaceQuotaDefinitionsUpdated[name] = JSON.parse(responseBody);
                });
                promises.push(p);
            }
        });
        return Promise.all(promises);
    }).then(function () {
        console.log("# END");
    }).catch(function (error) {
        console.log(error);
    });

function responseMessageHandler(responseMessage, resolve = function () { }, reject = function () { }, callback = function () { }) {
    const statusCode = responseMessage.statusCode;
    const contentType = responseMessage.headers['content-type'];

    let error;
    if (statusCode < 200 || statusCode >= 300) {
        error = new Error(`unexpected statusCode: statusCode = [${statusCode}]`);
    } else if (!/^application\/json/.test(contentType)) {
        error = new Error(`unexpected contentType: contentType = [${contentType}]`);
    }
    if (error) {
        console.log(error.message);
        responseMessage.resume();
        reject();
        return;
    }

    responseMessage.setEncoding('utf8');
    let rawData = '';
    responseMessage.on('data', (chunk) => rawData += chunk);
    responseMessage.on('end', () => { callback(rawData); resolve(rawData) });
}

function httpsGetPromise(options, callback) {
    return new Promise(function (resolve, reject) {
        https.get(options, (responseMessage) => {
            responseMessageHandler(responseMessage, resolve, reject, callback);
        }).on('error', (e) => {
            console.log(`https.get() error: error.message = [${e.message}]`);
            reject();
        });
    });
}

function httpsRequestPromise(options, postData, callback) {
    return new Promise(function (resolve, reject) {
        const clientRequest = https.request(options, (responseMessage) => {
            responseMessageHandler(responseMessage, resolve, reject, callback);
        }).on('error', (e) => {
            console.log(`https.get() error: error.message = [${e.message}]`);
            reject();
        });
        clientRequest.write(postData);
        clientRequest.end();
    });
}
