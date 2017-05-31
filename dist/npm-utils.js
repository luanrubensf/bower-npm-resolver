/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2016-2017 Mickael Jeanroy
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

'use strict';

/**
 * This module is used as a wrapper for NPM commands.
 * Each functions will returned a promise:
 *  - Resolved with the desired result.
 *  - Rejected with the error returned from NPM.
 */

var _ = require('lodash');
var requireg = require('requireg');
var npm = requireg('npm');
var Q = require('q');
var path = require('path');
var fs = require('fs');
var writeStreamAtomic = require('fs-write-stream-atomic');

/**
 * Load NPM and execute the given callback giving the deferred that should be
 * resolved or rejected in callback parameter.
 *
 * @param {function} cb The callback function executed once NPM has been loaded.
 * @return {Object} A promise, rejected if NPM cannot be loaded.
 */
function execNpm(cb) {
  var deferred = Q.defer();

  npm.load(function (err) {
    if (err) {
      deferred.reject(err);
    } else {
      cb(deferred);
    }
  });

  return deferred.promise;
}

/**
 * Executes `npm view` command with passed arguments.
 * Arguments is an array of `npm view` arguments.
 * So if cmd command was `npm view bower@1.7.7`, then argument
 * would be 'bower@1.7.7'.
 *
 * The returned promise will be resolved with the result of the cache command (i.e
 * object with all informations about the package).
 *
 * @param {Array} args THe package to download.
 * @return {Promise} The promise object
 */
function execViewCommand(args) {
  return execNpm(function (deferred) {
    npm.commands.view(args, true, function (err, data) {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve(data);
      }
    });
  });
}

/**
 * Executes `npm cache-add` command with passed arguments.
 * Arguments is the name of the cache to download.
 * So if cmd command was `npm cache-add bower@1.7.7 versions`, then argument
 * would be `['bower@1.7.7', 'versions']`.
 *
 * The returned promise will be resolved with the result of the cache command (i.e
 * object with all informations about the package).
 *
 * @param {Array} pkg THe package to download.
 * @return {Promise} The promise object
 */
function execCacheCommand(pkg) {
  return execNpm(function (deferred) {
    var cb = _.once(function (err, data) {
      if (err) {
        deferred.reject(err);
      } else {
        deferred.resolve(data);
      }
    });

    // NPM >= 5.0.0 now returns a promise instead of using last parameter as a callback
    var result = npm.commands.cache.add(pkg, null, null, false, cb);
    if (result && _.isFunction(result.then) && _.isFunction(result.catch)) {
      result.then(function (data) {
        return cb(null, data.manifest);
      }).catch(function (err) {
        return cb(err, null);
      });
    }
  });
}

/**
 * Returns the last key (in alpha-numeric order) of an object.
 *
 * @param {Object} o The object.
 * @return {string} The last key.
 */
function getLastKey(o) {
  var keys = Object.keys(o);
  keys.sort();
  return keys[keys.length - 1];
};

module.exports = {

  /**
   * Return the versions defined on NPM for a given package.
   * Basically, execute `npm view pkg versions` and return the results.
   * Note that NPM will return an object, such as:
   *
   * ```json
   *   { '1.7.7': { versions: ['1.0.0', '1.1.0' ] } }
   * ```
   *
   * The promise will be resolved with the array of versions (i.e `['1.0.0', '1.1.0' ]`).
   *
   * @param {String} pkg The package name.
   * @return {Promise} The promise object.
   */
  releases: function releases(pkg) {
    return execViewCommand([pkg, 'versions']).then(function (data) {
      // If it is already an array, return it.
      if (Array.isArray(data)) {
        return data;
      }

      // Otherwise, unwrap it.
      var mostRecentVersion = getLastKey(data);
      return data[mostRecentVersion].versions;
    });
  },


  /**
   * Download tarball using `npm pack pkg@version`, move to temporary folder and return
   * the location of the tarball in the temporary folder.
   *
   * The promise will be resolved with the tarball
   * path (i.e. `'/home/user/.cache/bower-1.7.7.tgz'`).
   *
   * @param {String} pkg The package name.
   * @param {String} version The package version.
   * @param {String} [dir] Tarball download location.
   * @return {Promise} The promise object.
   */
  downloadTarball: function downloadTarball(pkg, version, dir) {
    var deferred = Q.defer();

    execCacheCommand(pkg + '@' + version).then(function (data) {
      // The original `pack` command does not support custom directory output.
      // So, to avoid to change the current working directory pointed by `process.cwd()` (i.e
      // to avoid side-effect), we just copy the file manually.
      // This is basically what is done by `npm pack` command.
      // See: https://github.com/npm/npm/issues/4074
      // See: https://github.com/npm/npm/blob/v3.10.8/lib/pack.js#L49
      var targetDir = path.resolve(dir);
      var tarball = path.resolve(npm.cache, data.name, data.version, 'package.tgz');

      var name = data.name;

      // scoped packages get special treatment
      if (name[0] === '@') {
        name = name.substr(1).replace(/\//g, '-');
      }

      var fileName = name + '-' + data.version + '.tgz';

      var outputFile = path.join(targetDir, fileName);
      var inputStream = fs.createReadStream(tarball);
      var outputStream = writeStreamAtomic(outputFile);

      // Handle errors.
      inputStream.on('error', deferred.reject);
      outputStream.on('error', deferred.reject);

      // Handle success.
      outputStream.on('close', function () {
        deferred.resolve(outputFile);
      });

      inputStream.pipe(outputStream);
    }).catch(function (err) {
      console.log('err: ', err);
    });

    return deferred.promise;
  }
};