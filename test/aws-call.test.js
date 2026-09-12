'use strict';

/*
	aws.call()'s two typos.

	Both used to surface as raw JavaScript -- `TypeError: aws[clientObj.service]
	is not a constructor`, `TypeError: client[method] is not a function` -- naming
	neither the service, the method, nor aws.call() itself. The PascalCase one is
	the single most likely mistake there is against this API: AWS's own
	documentation, CLI and IAM actions all say GetCallerIdentity, and only SDK v2
	wants getCallerIdentity.

	Nothing here reaches AWS: the auth seam is swapped, and the guards fire before
	any request is made.
*/

const test = require('node:test');
const assert = require('node:assert');

const auth = require('../aws/auth');

auth._internal.ensureAuth = async () => {};

// The native takes JSON strings, because native arguments must be primitives.
const call = (service, method, params = {}) =>
    auth.aws[0](JSON.stringify({ service, params: { region: 'us-east-1' } }), method, JSON.stringify(params));

test('an unknown client names itself, and says how clients are spelled', async () => {
    await assert.rejects(() => call('Lambdaa', 'listFunctions'), (e) => {
        assert.match(e.message, /aws\.call\(\)/);
        assert.match(e.message, /'Lambdaa' is not an aws-sdk v2 client/);
        assert.doesNotMatch(e.message, /is not a constructor/);
        return true;
    });
});

test('a PascalCase method is met with the lowerCamelCase spelling of itself', async () => {
    await assert.rejects(() => call('STS', 'GetCallerIdentity'), (e) => {
        assert.match(e.message, /'STS' has no method 'GetCallerIdentity'/);
        assert.match(e.message, /try 'getCallerIdentity'/);
        return true;
    });
});

test('a method that does not exist in either casing says so without guessing', async () => {
    await assert.rejects(() => call('STS', 'notAMethod'), (e) => {
        assert.match(e.message, /has no method 'notAMethod'/);
        assert.doesNotMatch(e.message, /try '/, 'suggested a method that does not exist either');
        return true;
    });
});
