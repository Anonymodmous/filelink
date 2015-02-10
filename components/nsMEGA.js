/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* This file implements the nsIMsgCloudFileProvider interface.
 *
 * This component handles the MEGA implementation of the
 * nsIMsgCloudFileProvider interface.
 */

const Cu = Components.utils;
const Cr = Components.results;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/cloudFileAccounts.js");

const kMaxFileSize = Math.pow(2,32) - 1;
const kAuthSecretRealm = "MEGA Auth Secret";

var LOG = function() {
	ERR.apply(this, arguments);
};

if (0) try {
	let { Log4Moz } = Cu.import("resource:///modules/gloda/log4moz.js", {});
	let Logger = Log4Moz.getConfiguredLogger("MEGA");
	LOG = Logger.info.bind(Logger);
	LOG.logger = Logger;
} catch(e) {
	Cu.reportError(e);
}

function ERR() {
	let stack = "\n" + new Error().stack.split("\n")
		.map(s => s.replace(/^(.*@).+\//,'$1')).join("\n");
	let args = [].slice.call(arguments);
	args.unshift(new Date().toISOString());
	Cu.reportError(args.join(" ") + stack);
	if (typeof LOG.logger !== 'undefined') {
		LOG.logger.error.apply(LOG.logger, arguments);
	}
}
const console = {
	log : function() {
		LOG([].slice.call(arguments).join(" "));
	}
};

(function(global) global.loadSubScript = function(file,scope)
	Services.scriptloader.loadSubScript(file,scope||global))(this);

const M = {
	d : !0,
	console : console,
	localStorage : {
		removeItem : function (v) {
			delete this[v]
		}
	},
	clearTimeout : function (t) {
		if (t)
			t.cancel();
	},
	setTimeout : function (f, n) {
		let args = [].slice.call(arguments, 2);
		function Call() {
			try {
				f.apply(this, args);
			} catch (e) {
				ERR(e);
			}
		}
		let i = Ci.nsITimer, t = Cc["@mozilla.org/timer;1"].createInstance(i);
		t.initWithCallback({notify:Call}, n || 30, i.TYPE_ONE_SHOT);
		return t;
	}
};
['sjcl', 'asmcrypto', 'user', 'crypto'].forEach(function (file) {
	try {
		loadSubScript('chrome://mega-filelink/content/core/' + file + '.js', M);
	} catch (e) {
		ERR(e);
	}
});

function nsMEGA() {}
nsMEGA.prototype = {
	QueryInterface : XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider]),

	classID : Components.ID("{3857A119-990E-43B3-A7E5-92132D13FCC0}"),

	get type()"MEGA",
	get displayName()"MEGA",
	get serviceURL()"https://mega.co.nz/",
	get iconClass()"chrome://mega-filelink/content/logo16.png",
	get accountKey()this._accountKey,
	get lastError()this._lastErrorText,
	get settingsURL()"chrome://mega-filelink/content/settings.xhtml",
	get managementURL()"chrome://mega-filelink/content/management.xhtml",

	_accountKey : false,
	_prefBranch : null,
	_loggedIn : false,
	_authToken : "",
	_userInfo : null,
	_file : null,
	_requestDate : null,
	_successCallback : null,
	_request : null,
	_uploadingFile : null,
	_uploader : null,
	_lastErrorStatus : 0,
	_lastErrorText : "",
	_maxFileSize : kMaxFileSize,
	_totalStorage : -1,
	_fileSpaceUsed : -1,
	_uploads : [],
	_urlsForFiles : {},
	_uploadInfo : {}, // upload info keyed on aFiles.

	/**
	 * If we don't know the limit, this will return -1.
	 */
	get fileSpaceUsed() this._fileSpaceUsed,
	get fileUploadSizeLimit() this._maxFileSize,
	get remainingFileSpace() this._totalStorage - this._fileSpaceUsed,

	/**
	 * Initialize this instance of nsMEGA, setting the accountKey.
	 *
	 * @param aAccountKey the account key to initialize this provider with
	 */
	init : function nsMEGA_init(aAccountKey) {
		this._accountKey = aAccountKey;
		this._prefBranch = Services.prefs
			.getBranch("mail.cloud_files.accounts." + aAccountKey + ".");
		this._userName = this._prefBranch.getCharPref("username");
	},

	/**
	 * The callback passed to an nsMEGAFileUploader, which is fired when
	 * nsMEGAFileUploader exits.
	 *
	 * @param aRequestObserver the request observer originally passed to
	 *                         uploadFile for the file associated with the
	 *                         nsMEGAFileUploader
	 * @param aStatus the result of the upload
	 */
	_uploaderCallback : function nsMEGA__uploaderCallback(aRequestObserver,aStatus) {
		aRequestObserver.onStopRequest(null, null, aStatus);
		this._uploadingFile = null;
		this._uploads.shift();
		if (this._uploads.length > 0) {
			let nextUpload = this._uploads[0];
			LOG("chaining upload, file = " + nextUpload.file.leafName);
			this._uploadingFile = nextUpload.file;
			this._uploader = nextUpload;
			try {
				this.uploadFile(nextUpload.file, nextUpload.callback);
			} catch (ex) {
				nextUpload.callback(nextUpload.requestObserver, Cr.NS_ERROR_FAILURE);
			}
		} else {
			this._uploader = null;
		}
	},

	/**
	 * Attempts to upload a file to MEGA.
	 *
	 * @param aFile the nsILocalFile to be uploaded
	 * @param aCallback an nsIRequestObserver for listening for the starting
	 *                  and ending states of the upload.
	 */
	uploadFile : function nsMEGA_uploadFile(aFile, aCallback) {
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;

		LOG("uploading " + aFile.leafName);

		// Some ugliness here - we stash requestObserver here, because we might
		// use it again in _getUserInfo.
		this.requestObserver = aCallback;

		// if we're uploading a file, queue this request.
		if (this._uploadingFile && this._uploadingFile != aFile) {
			let uploader = new nsMEGAFileUploader(this, aFile,
					this._uploaderCallback.bind(this, aCallback),
					aCallback);
			this._uploads.push(uploader);
			return;
		}
		this._file = aFile;
		this._uploadingFile = aFile;

		let successCallback = this._finishUpload.bind(this, aFile, aCallback);
		if (!this._loggedIn)
			return this._logonAndGetUserInfo(successCallback, null, true);
		LOG("getting user info");
		if (!this._userInfo)
			return this._getUserInfo(successCallback);
		successCallback();
	},

	/**
	 * A private function used to ensure that we can actually upload the file
	 * (we haven't exceeded file size or quota limitations), and then attempts
	 * to kick-off the upload.
	 *
	 * @param aFile the nsILocalFile to upload
	 * @param aCallback an nsIRequestObserver for monitoring the starting and
	 *                  ending states of the upload.
	 */
	_finishUpload : function nsMEGA__finishUpload(aFile, aCallback) {
		let exceedsFileLimit = Ci.nsIMsgCloudFileProvider.uploadExceedsFileLimit;
		let exceedsQuota = Ci.nsIMsgCloudFileProvider.uploadWouldExceedQuota;
		if (!aFile.fileSize || aFile.fileSize > this._maxFileSize)
			return aCallback.onStopRequest(null, null, exceedsFileLimit);
		if (aFile.fileSize > this.remainingFileSpace)
			return aCallback.onStopRequest(null, null, exceedsQuota);

		delete this._userInfo; // force us to update userInfo on every upload.

		if (!this._uploader) {
			this._uploader = new nsMEGAFileUploader(this, aFile,
					this._uploaderCallback.bind(this, aCallback),
					aCallback);
			this._uploads.unshift(this._uploader);
		}

		this._uploadingFile = aFile;
		this._uploader.uploadFile();
	},

	/**
	 * Attempts to cancel a file upload.
	 *
	 * @param aFile the nsILocalFile to cancel the upload for.
	 */
	cancelFileUpload : function nsMEGA_cancelFileUpload(aFile) {
		if (this._uploadingFile.equals(aFile)) {
			this._uploader.cancel();
		} else {
			for (let i = 0; i < this._uploads.length; i++)
				if (this._uploads[i].file.equals(aFile)) {
					this._uploads[i].requestObserver.onStopRequest(
						null, null, Ci.nsIMsgCloudFileProvider.uploadCanceled);
					this._uploads.splice(i, 1);
					return;
				}
		}
	},

	/**
	 * Store the shared link associated with a local file.
	 *
	 * @param aFile  The nsILocalFile the url belongs to
	 * @param aLink  The URL to store for the file
	 * @param aHandle The handle for the uploaded file
	 * @param aHash The checksum for the file
	 */
	_setSharedURL : function nsMEGA__setSharedURL(aFile, aLink, aHandle, aHash) {
		this._urlsForFiles[aFile.path] = aLink;
		if (aHandle && this.db)
			try {
				let stm = this.db.createAsyncStatement(
						'INSERT INTO ftou (time, file, link, node, hash) ' +
						'VALUES           (:time, :file, :link, :node, :hash)');

				stm.params.time = aFile.lastModifiedTime;
				stm.params.file = aFile.path;
				stm.params.link = aLink;
				stm.params.node = aHandle;
				stm.params.hash = aHash || "";

				try {
					stm.executeAsync({
						handleError : ERR,
						handleResult : ERR,
						handleCompletion : function (aResult) {
							LOG('DB transaction finished, ' + aResult);
						}
					});
				}
				finally {
					stm.finalize();
				}
			} catch (e) {
				ERR(e);
			}
	},

	/**
	 * A private function used to retrieve the profile information for the
	 * user account associated with the accountKey.
	 *
	 * @param successCallback the function called if information retrieval
	 *                        is successful
	 * @param failureCallback the function called if information retrieval fails
	 */
	_getUserInfo : function nsMEGA__getUserInfo(successCallback,failureCallback) {
		LOG('_getUserInfo')
		if (!successCallback)
			successCallback = function () {
				this.requestObserver
				.onStopRequest(null, null,
					this._loggedIn ? Cr.NS_OK : Ci.nsIMsgCloudFileProvider.authErr);
			}.bind(this);

		if (!failureCallback)
			failureCallback = function () {
				this.requestObserver
				.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.authErr);
			}.bind(this);

		M.api_req({a : 'uq', strg : 1, xfer : 1},
		{
			callback : function (res) {
				if (typeof res == 'object') {
					this._userInfo = res;
					this._totalStorage = Math.round(res.mstrg);
					this._fileSpaceUsed = Math.round(res.cstrg);
					successCallback();
				} else {
					failureCallback();
				}
			}.bind(this)
		});
	},

	/**
	 * A private function that first ensures that the user is logged in, and then
	 * retrieves the user's profile information.
	 *
	 * @param aSuccessCallback the function called on successful information
	 *                         retrieval
	 * @param aFailureCallback the function called on failed information retrieval
	 * @param aWithUI a boolean for whether or not we should display authorization
	 *                UI if we don't have a valid token anymore, or just fail out.
	 */
	_logonAndGetUserInfo : function nsMEGA_logonAndGetUserInfo(aSuccessCallback,
		aFailureCallback,
		aWithUI) {
		LOG('_logonAndGetUserInfo')
		if (!aFailureCallback)
			aFailureCallback = function () {
				this.requestObserver
				.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.authErr);
			}.bind(this);

		return this.logon(function () {
			this._getUserInfo(aSuccessCallback, aFailureCallback);
		}.bind(this), aFailureCallback, aWithUI);
	},

	/**
	 * For some nsILocalFile, return the associated sharing URL.
	 *
	 * @param aFile the nsILocalFile to retrieve the URL for
	 */
	urlForFile : function nsMEGA_urlForFile(aFile) {
		LOG('urlForFile ' + aFile.path + ', ' + this._urlsForFiles[aFile.path]);
		return this._urlsForFiles[aFile.path];
	},

	/**
	 * Updates the profile information for the account associated with the
	 * account key.
	 *
	 * @param aWithUI a boolean for whether or not we should display authorization
	 *                UI if we don't have a valid token anymore, or just fail out.
	 * @param aRequest an nsIRequestObserver for observing the starting and
	 *                  ending states of the request.
	 */
	refreshUserInfo : function nsMEGA_refreshUserInfo(aWithUI, aRequest) {
		LOG('refreshUserInfo: ' + this._loggedIn)
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;
		this.requestObserver = aRequest;
		aRequest.onStartRequest(null, null);
		if (!this._loggedIn)
			return this._logonAndGetUserInfo(null, null, aWithUI);
		if (!this._userInfo)
			return this._getUserInfo();
		return this._userInfo;
	},

	/**
	 * Our MEGA implementation does not implement the createNewAccount
	 * function defined in nsIMsgCloudFileProvider.idl.
	 */
	createNewAccount : function nsMEGA_createNewAccount(aEmailAddress,
		aPassword, aFirstName,aLastName) {
		return Cr.NS_ERROR_NOT_IMPLEMENTED;
	},

	/**
	 * Attempts to communicate with the service provider in order to get the
	 * proper credentials for starting uploads.
	 *
	 * @param aRequestObserver  The nsIRequestObserver for monitoring the start
	 *                          and stop states of the creation operation.
	 */
	createExistingAccount : function nsMEGA_createExistingAccount(aRequestObserver) {
		let successCb = function (aResponseText, aRequest) {
			aRequestObserver.onStopRequest(null, this, Cr.NS_OK);
		}.bind(this);

		let failureCb = function (aResponseText, aRequest) {
			aRequestObserver.onStopRequest(null, this,
				Ci.nsIMsgCloudFileProvider.authErr);
		}.bind(this);

		this.logon(successCb, failureCb, true);
	},

	/**
	 * If the provider doesn't have an API for creating an account, perhaps
	 * there's a url we can load in a content tab that will allow the user
	 * to create an account.
	 */
	get createNewAccountUrl() "",

	/**
	 * For a particular error, return a URL if MEGA has a page for handling
	 * that particular error.
	 *
	 * @param aError the error to get the URL for
	 */
	providerUrlForError : function nsMEGA_providerUrlForError(aError) {
		return "";
	},

	/**
	 * Attempt to delete an upload file if we've uploaded it.
	 *
	 * @param aFile the file that was originall uploaded
	 * @param aCallback an nsIRequestObserver for monitoring the starting and
	 *                  ending states of the deletion request.
	 */
	deleteFile : function nsMEGA_deleteFile(aFile, aCallback) {
		LOG('deleteFile', aFile.path);
		if (Services.io.offline)
			throw Ci.nsIMsgCloudFileProvider.offlineErr;

		let uploadInfo = this._uploadInfo[aFile.path];
		if (!uploadInfo)
			throw Cr.NS_ERROR_FAILURE;

		this.requestObserver = aCallback;
		let path = wwwFormUrlEncode(uploadInfo.path);
		let url = gServerUrl + kDeletePath + "&path=" + uploadInfo.path;
		LOG("Sending delete request to " + url);
		let oauthParams =
			[["root", "sandbox"], ["path", path]];
		this._connection.signAndSend(url, "", "POST", null,
			function (aResponseText, aRequest) {
			LOG("success deleting file; response = " + aResponseText);
			aCallback.onStopRequest(null, null, Cr.NS_OK);
		}.bind(this),
		function (aException, aResponseText, aRequest) {
			ERR("failed deleting file; response = " + aResponseText);
			aCallback.onStopRequest(null, null, Ci.nsIMsgCloudFileProvider.uploadErr);
		}.bind(this), this, null);
	},

	/**
	 * This function is used by our testing framework to override the default
	 * URL's that nsMEGA connects to.
	 */
	overrideUrls : function nsMEGA_overrideUrls(aNumUrls, aUrls) {
		gServerUrl = aUrls[0];
	},

	/**
	 * logon to the mega account.
	 *
	 * @param successCallback - called if logon is successful
	 * @param failureCallback - called back on error.
	 * @param aWithUI if false, logon fails if it would have needed to put up UI.
	 *                This is used for things like displaying account settings,
	 *                where we don't want to pop up the oauth ui.
	 */
	logon : function nsMEGA_logon(successCallback, failureCallback, aWithUI) {
		let p = this._authData.$pw;

		if (!p) {
			if (aWithUI) {
				p = this.askPassword();
			}

			if (!p) {
				mozRunAsync(failureCallback);
				return;
			}
		}

		let ctx = {
			_checking : !0,
			checkloginresult : function (ctx, r) {
				LOG('checkloginresult, u_type: ' + r);
				if (r == 3) {
					M.u_type = r;
					this._loggedIn = true;
					LOG('Logged in as ' + JSON.parse(M.localStorage.attr).name);
					if (ctx._checking !== true) {
						this._getUserInfo(function () {
                        	let cstrgn = this._userInfo.cstrgn;
                        	if (!cstrgn)
                        		ERR("Missing 'cstrgn'");
                        	else {
                        		cstrgn = Object.keys(cstrgn);
                        		if (cstrgn.length < 3)
                        			ERR("Invalid 'cstrgn'");
                        		else {
                        			let a = String(cstrgn[0]);
                        			let b = String(cstrgn[2]);
                        			LOG('RootID: ' + a);
                        			LOG('RubbishID: ' + b);
                        			if ((a + b).length != 16)
                        				ERR("Unexpected 'cstrgn'");
                        			else {
                        				M.localStorage.kRootID = a;
                        				M.localStorage.kRubbishID = b;
                        				M.createfolder('Thunderbird', function (res) {
                        					if (typeof res !== 'string')
                        						ERR('Error creating folder: ' + res);
                        					else
                        						LOG('Thunderbird folder created with ID ' + res);
											this._authData = p;
											successCallback();
                        				}.bind(this));
                        			}
                        		}
                        	}
                        	if (!M.localStorage.kRootID) {
								failureCallback();
                        	}
						}.bind(this), failureCallback);
					} else {
						successCallback();
					}
				} else if (ctx._checking === true) {
					delete ctx._checking;
					try {
						M.u_login(ctx, this._userName, p, null);
					} catch (e) {
						alert(e);
						failureCallback();
					}
				} else {
					failureCallback();
				}
			}.bind(this)
		};
		try {
			M.u_checklogin(ctx);
		} catch (e) {
			ERR(e);
			mozRunAsync(failureCallback);
		}
	},

	/**
	 * Prompts the user for a password. Returns the empty string on failure.
	 */
	askPassword : function () {
		LOG("Getting password for user: " + this._userName);

		let password = { value : "" };
		let messengerBundle = Services.strings
			.createBundle("chrome://messenger/locale/messenger.properties");
		let win = Services.wm.getMostRecentWindow(null);
		let authPrompter = Services.ww.getNewAuthPrompter(win);
		let promptString = messengerBundle.formatStringFromName("passwordPrompt",
				[this._userName,
					this.displayName],
				2);

		let serviceURL = this.serviceURL.replace('//',
			'//' + encodeURIComponent(this._userName) + '@');
		if (authPrompter.promptPassword(this.displayName, promptString,
				serviceURL, authPrompter.SAVE_PASSWORD_PERMANENTLY, password))
			return password.value;

		return "";
	},

	/**
	 * Retrieves the cached auth secret for this account.
	 */
	get _authData() {
		let data = cloudFileAccounts.getSecretValue(this.accountKey, kAuthSecretRealm);
		LOG('Got authData: ' + data);
		if (data)
			try {
				data = JSON.parse(M.base64urldecode(data));
				for (let k in data) {
					if (k !== '$pw') {
						M.localStorage[k] = data[k];
					}
				}
				return data;
			} catch (e) {
				ERR(e);
			}
		M.sessionStorage = M.localStorage;
		return {};
	},

	/**
	 * Sets the cached auth secret for this account.
	 *
	 * @param aPassword the pwd secret to cache.
	 */
	set _authData(aPassword) {
		if (aPassword) {
			let data = {
				'$pw' : aPassword
			};
			for (let k in M.localStorage) {
				if (k !== 'removeItem') {
					data[k] = M.localStorage[k];
				}
			}
			aPassword = M.base64urlencode(JSON.stringify(data));
			LOG('Saved authData: ' + aPassword);
		}
		cloudFileAccounts.setSecretValue(this.accountKey, kAuthSecretRealm, aPassword || "");
	},

	/**
	 * Retrieves the cached auth token for this account.
	 */
	get _cachedAuthToken() {
		let authToken = cloudFileAccounts.getSecretValue(this.accountKey,
				cloudFileAccounts.kTokenRealm);
		if (!authToken)
			return "";

		return authToken;
	},

	/**
	 * Sets the cached auth token for this account.
	 *
	 * @param aAuthToken the auth token to cache.
	 */
	set _cachedAuthToken(aAuthToken) {
		cloudFileAccounts.setSecretValue(this.accountKey,
			cloudFileAccounts.kTokenRealm,
			aAuthToken);
	}
};

function nsMEGAFileUploader(aOwner, aFile, aCallback, aRequestObserver) {
	LOG("new nsMEGAFileUploader file = " + aFile.leafName);
	this.file            = aFile;
	this.owner           = aOwner;
	this.callback        = aCallback;
	this.requestObserver = aRequestObserver;
}

let rID = 0;
function nsMEGAChunkUploader(aUploader, aOffset, aLength) {
	this.pid      = 'Chunk$' + aOffset + '.' + aLength + '-' + (++rID);
	this.backoff  = 400+Math.floor(Math.random()*600);
	this.uploader = aUploader;
	this.offset   = aOffset;
	this.bytes    = aLength;
	this.retries  = 0;
}
nsMEGAChunkUploader.prototype = {
	/**
	 * Start uploading a chunk of data
	 */
	start : function nsMCU_start() {
		let url = this.uploader.url + this.suffix;
		let xhr, chunk = this;

		LOG('Starting nsMEGAChunkUploader ' + chunk.pid + ' for ' + url);

		xhr = M.getxhr();
		xhr.onerror = xhr.ontimeout = function nsMCX_OnError(ev) {
			LOG(chunk.pid + ' nsMEGAChunkUploader XHR ' + ev.type);
			chunk.uploader.lastError = ev.type;
			chunk._error();
		};
		xhr.onload = function nsMCX_OnLoad(ev) {
			LOG(chunk.pid + ' nsMEGAChunkUploader XHR Load ' + xhr.status);

			if (xhr.status == 200 && typeof xhr.response === 'string' && xhr.statusText == 'OK') {
				let response = xhr.response;
				if (response.length > 27) {
					response = M.base64urldecode(response);
				}
				LOG('nsMEGAChunkUploader ' + chunk.pid + ' finished, ' + response.length);

				let u = chunk.uploader;
				if (!response.length || response == 'OK' || response.length == 27) {

					if (response.length == 27) {
						let t = Object.keys(u.ul_macs)
							.map(Number)
							.sort((a, b) => a - b)
							.map(m => u.ul_macs[m]);
						let key = u.ul_key;
						let mac = M.condenseMacs(t, key);
						key = [
							key[0]^key[4],
							key[1]^key[5],
							key[2]^mac[0]^mac[1],
							key[3]^mac[2]^mac[3],
							key[4],
							key[5],
							mac[0]^mac[1],
							mac[2]^mac[3]
						];

						t = { n : u.file.leafName, hash : u.hash };
						M.api_completeupload(response, t, key, u._complete.bind(u, key));
					}

					delete chunk.u8data;
					delete u.activeUploads[chunk.pid];
					mozRunAsync(u._dispatch.bind(u));
				} else {
					ERR('EKEY Upload Error');
					u._restart(EKEY);
				}
			} else {
				LOG('nsMEGAChunkUploader ' + chunk.pid + ' FAILED, ' + xhr.response + ' (' + xhr.status + ') ' + xhr.statusText);
				chunk._error();
			}
		};
		xhr.timeout = 180000;
		xhr.open('POST', url);
		xhr.channel.loadFlags |= (
			Ci.nsIRequest.LOAD_ANONYMOUS |
			Ci.nsIRequest.LOAD_BYPASS_CACHE |
			Ci.nsIRequest.INHIBIT_PERSISTENT_CACHING);
		xhr.send(this.u8data.buffer);
		this.xhr = xhr;
	},

	/**
	 * Handle an error uploading a chunk
	 */
	_error : function () {
		if (this.xhr) {
			delete this.xhr;
			if (++this.retries < this.uploader.maxChunkRetries) {
				this.retryTimer = M.setTimeout(this.start.bind(this), this.backoff *= 1.7);
			} else {
				this.uploader.cancel(Ci.nsIMsgCloudFileProvider.uploadErr);
			}
		}
	}
};

let mEncrypter;
function nsMEGAEncrypter() {
	let n = this.nw = 4;

	this.queue = [];
	this.worker = Array(n);

	while (n--) {
		let wrk = new Worker("chrome://mega-filelink/content/core/encrypter.js");

		wrk.onmessage = function nsMEW_OnMessage(ev) {
			let job = this.job, chunk = job.chunk, uploader = chunk.uploader;

			LOG(chunk.pid + ' Worker Reply: ' + ev.data);

			if (typeof ev.data == 'string') {
				if (ev.data[0] == '[')
					uploader.ul_macs[chunk.offset] = JSON.parse(ev.data);
			} else {
				try {
					chunk.u8data = new Uint8Array(ev.data.buffer || ev.data);
					chunk.suffix = '/' + chunk.offset + '?c=' + M.base64urlencode(M.chksum(chunk.u8data.buffer));
					if (job.callback) {
						job.callback(chunk);
					}
					mozRunAsync(mEncrypter.pop.bind(mEncrypter));
					delete this.job;
					delete this.busy;
				} catch (e) {
					ERR(e);
					this.onerror(e);
				}
			}
		};

		wrk.onerror = function nsMEW_OnError(err) {
			ERR(this.job.chunk.pid + ' Worker Exception: ' + err);

			this.job.chunk.uploader.cancel(Cr.NS_ERROR_FAILURE);
		};

		this.worker[n] = wrk;
	}
}
nsMEGAEncrypter.prototype = {
	push : function nsMEPush(aChunkUploader, aData, aCallback) {
		this.queue.push({
			data : aData,
			chunk : aChunkUploader,
			callback : aCallback
		});
		aChunkUploader.ready = true;
		if (aCallback)
			this.pop();
	},
	pop : function nsMEPop() {
		let n = this.nw;
		while (n--) {
			let wrk = this.worker[n];
			if (!wrk.busy) {
				let job = this.queue.shift();
				if (!job)
					break;

				LOG('Starting nsMEGAEncrypter $' + job.chunk.offset);

				wrk.job = job;
				wrk.busy = true;
				wrk.postMessage(job.chunk.uploader.ul_keyNonce);
				wrk.postMessage(job.chunk.offset / 16);
				wrk.postMessage(job.data.buffer);
			}
		}
	},
	exists : function (chunk) {
		let i = this.queue.length;
		while (i--) {
			if (this.queue[i].chunk === chunk) {
				return this.queue[i];
			}
		}
		for (i = this.nw; i--; ) {
			let wrk = this.worker[i];
			if (wrk.busy && wrk.job.chunk === chunk) {
				return wrk.job;
			}
		}
		return false;
	}
};

nsMEGAFileUploader.prototype = {
	file : null,
	owner : null,
	retries : -1,
	callback : null,
	lastError : null,
	inputStream : null,
	binaryStream : null,
	activeUploads : null,
	get maxSimUploads()     4,
	get maxChunkRetries()   7,
	get maxUploadRetries()  9,
	get maxEncrypterJobs() 16,

	/**
	 * Kicks off the upload request for the file associated with this Uploader.
	 */
	uploadFile : function nsMFU_uploadFile(aRetry) {
		if (!aRetry)
			this.requestObserver.onStartRequest(null, null);

		if (!this.owner.db) {
			let file;
			try {
				file = Services.dirsvc.get("ProfD", Ci.nsIFile);
				file.append("megalinks.sqlite");
				let db = Services.storage.openDatabase(file);
				if (!db.tableExists('ftou')) {
					db.createTable('ftou', "time INTEGER, file STRING, link STRING, node STRING, hash STRING");
				}
				this.owner.db = db;
			} catch (e) {
				ERR(e);
				if (e.result != Cr.NS_ERROR_OUT_OF_MEMORY)
					try {
						if (file && file.exists()) {
							file.remove(false);
							if (!aRetry) {
								return this.uploadFile(true);
							}
						}
					} catch (e) {
						ERR(e);
					}
			}
		}

		if (this.owner.db) {
			let cached_link;
			let stm = this.owner.db.createStatement("SELECT * FROM ftou WHERE file = :file LIMIT 1");
			stm.params.file = this.file.path;
			try {
				while (stm.step()) {
					let row = stm.row;
					LOG('Got DB Item with link ' + row.link);
					if (+row.time == this.file.lastModifiedTime) {
						LOG('Has matching time ' + row.time);
						cached_link = row.link;
					}
				}
			} catch (e) {
				ERR(e);
			} finally {
				stm.reset();
			}

			if (cached_link) {
				this.owner._setSharedURL(this.file, cached_link);
				return mozRunAsync(function () {
					this.callback(Cr.NS_OK);
				}.bind(this));
			}
		}

		LOG("uploadFile: " + this.file.leafName);
		try {
			this.inputStream = Cc["@mozilla.org/network/file-input-stream;1"]
				.createInstance(Ci.nsIFileInputStream);
			this.inputStream.QueryInterface(Ci.nsISeekableStream);
			this.inputStream.init(this.file, -1, -1, false);

			this.binaryStream = Cc["@mozilla.org/binaryinputstream;1"]
				.createInstance(Ci.nsIBinaryInputStream);
			this.binaryStream.setInputStream(this.inputStream);

			LOG('Generating fingerprint for ' + this.file.leafName);
			M.fingerprint(this, function __fingerprint_cb(hash) {
				LOG('fingerprint: ' + hash);
				if (hash)
					this.hash = hash;
				try {
					this._init();
				} catch (e) {
					ERR(e);
					mozRunAsync(this.cancel.bind(this, Cr.NS_ERROR_FAILURE));
				}
			}.bind(this));
		} catch (e) {
			ERR(e);
			mozRunAsync(this.cancel.bind(this, Cr.NS_ERROR_FAILURE));
		}
	},

	/**
	 * Cancels the upload request for the file associated with this Uploader.
	 *
	 * @param aStatus  If an error, why are we canceling the upload
	 */
	cancel : function nsMFU_cancel(aStatus) {
		LOG('Canceling upload ' + this.file.leafName + ', ' + aStatus);
		this._abort();
		this._close();
		this.callback(aStatus || Ci.nsIMsgCloudFileProvider.uploadCanceled);
		delete this.callback;
	},

	/**
	 * Close the associated input stream for this upload
	 */
	_close : function nsMFU__close() {
		if (this.binaryStream) {
			mozCloseStream(this.inputStream);
			delete this.inputStream;
			delete this.binaryStream;
		}
	},

	/**
	 * Reads a chunk of data from disk, returns a typed-array
	 *
	 * @param aOffset The offset to starter reading from
	 * @param aLength The number of bytes to read
	 */
	_read : function nsMFU__read(aOffset, aLength) {
		try {
			this.inputStream.seek(0, aOffset);
			let data = this.binaryStream.readByteArray(aLength);
			return new Uint8Array(data);
		} catch (e) {
			ERR(e);
		}
		return null;
	},

	/**
	 * Reads a chunk of data from disk, returns a string
	 *
	 * @param aOffset The offset to starter reading from
	 * @param aLength The number of bytes to read
	 */
	_read2 : function nsMFU__read2(aOffset, aLength) {
		try {
			this.inputStream.seek(0, aOffset);
			return this.binaryStream.readBytes(aLength);
		} catch (e) {
			ERR(e);
		}
		return null;
	},

	/**
	 * Abort active workers and chunk uploads
	 */
	_abort : function nsMFU__abort() {
		if (mEncrypter) {
			mEncrypter.worker.map(w => w.terminate());
			mEncrypter = null;
		}
		for each(let chunk in this.activeUploads) {
			LOG('Aborting ' + chunk.pid + ', ' + (typeof chunk.xhr));
			let xhr = chunk.xhr;
			if (xhr) {
				delete chunk.xhr;
				if (xhr.channel) {
					xhr.channel.cancel(Cr.NS_BINDING_ABORTED);
				} else {
					xhr.abort();
				}
			}
			M.clearTimeout(chunk.retryTimer);
		}
		delete this.chunks;
		delete this.activeUploads;
	},

	/**
	 * Dispatch a queued chunk, read -> encrypt -> upload
	 */
	_dispatch : function nsMFU__dispatch() {
		let t = this.maxSimUploads - Object.keys(this.activeUploads).length;
		LOG('_dispatch, ' + t + ' slots');
		while (t--) {
			let chunk = this.chunks.pop(), job, callback;
			if (!chunk)
				break;

			callback = chunk.start.bind(chunk);
			if ((job = mEncrypter.exists(chunk))) {
				LOG('Got pending encrypter job, ' + chunk.pid + '; ' + (typeof job.callback));
				job.callback = callback;
			} else if (!chunk.u8data) {
				let data = this._read(chunk.offset, chunk.bytes);
				if (!data)
					return this.cancel(Cr.NS_ERROR_FAILURE);

				mEncrypter.push(chunk, data, callback);
			} else {
				mozRunAsync(callback);
			}
			this.activeUploads[chunk.pid] = chunk;
		}

		if (this.chunks.length) {
			let idx = this.chunks.length;
			while (mEncrypter.queue.length < this.maxEncrypterJobs) {
				let chunk = this.chunks[--idx];
				if (!chunk || chunk.u8data)
					break;

				if (!chunk.ready) {
					let data = this._read(chunk.offset, chunk.bytes);
					if (!data)
						break;

					mEncrypter.push(chunk, data);
				}
			}
			mozRunAsync(mEncrypter.pop.bind(mEncrypter));
		}
		LOG('activeUploads', Object.keys(this.activeUploads).length);
	},

	/**
	 * Completes an upload.
	 *
	 * @param aKey     The encryption key
	 * @param aHandle  The handle for the uploaded file
	 */
	_complete : function nsMFU__complete(aKey, aHandle) {
		if (aHandle) {
			let link = 'https://mega.co.nz/#!' + aHandle + '!' + M.a32_to_base64(aKey);
			this.owner._setSharedURL(this.file, link, aHandle, this.hash);
			this.callback(Cr.NS_OK);
		} else {
			ERR('Upload error');
			this.cancel(Ci.nsIMsgCloudFileProvider.uploadErr);
		}
		this._close();
	},

	/**
	 * Restart from scratch a failed upload
	 */
	_restart : function nsMFU__restart(aStatus) {
		this.lastError = aStatus;
		try {
			this._abort();
			this._init();
		} catch (e) {
			this.cancel(Cr.NS_ERROR_FAILURE);
		}
	},

	/**
	 * Initialize the file upload procedure
	 */
	_init : function nsMFU__init() {

		if (++this.retries > this.maxUploadRetries) {
			return this.cancel(Ci.nsIMsgCloudFileProvider.uploadErr);
		}

		if (!mEncrypter)
			mEncrypter = new nsMEGAEncrypter();

		M.api_req({
			a : 'u',
			ssl : 0,
			ms : 0,
			s : this.file.fileSize,
			r : this.retries,
			e : this.lastError || ""
		}, {
			callback : function (res, ctx) {

				if (typeof res === 'object' && /^http/.test(String(res.p))) {
					this.url = res.p;
					this.ul_macs = [];
					if (!this.ul_key) {
						this.ul_key = Array(6);
						for (let i = 6; i--; )
							this.ul_key[i] = M.rand(0x100000000);
						this.ul_keyNonce = JSON.stringify(this.ul_key);
					}
					let offset = 0, index = 0, i;
					let chunks = [], size = this.file.fileSize;
					let chunk_size = 1048576, block_size = 131072;
					for (i = 1; i <= 8 && offset < size - i * block_size; i++) {
						chunks.push(new nsMEGAChunkUploader(this, index = offset, i * block_size));
						offset += i * block_size
					}
					while (offset < size) {
						chunks.push(new nsMEGAChunkUploader(this, index = offset, chunk_size));
						offset += chunk_size
					}
					if (size - index > 0) {
						chunks.pop();
						chunks.push(new nsMEGAChunkUploader(this, index, size - index));
					}
					LOG('File split into ' + chunks.length + ' chunks');
					this.chunks = chunks.reverse();
					this.activeUploads = {};
					this._dispatch();
				} else {
					ERR('u-handshake error');
					this.cancel(Cr.NS_ERROR_FAILURE);
				}
			}.bind(this)
		});
	}
};

const mozLazyGetService = XPCOMUtils.defineLazyServiceGetter.bind(XPCOMUtils, this);

mozLazyGetService("mozMIMEService", "@mozilla.org/mime;1", "nsIMIMEService");
mozLazyGetService("mozAlertsService", "@mozilla.org/alerts-service;1", "nsIAlertsService");
mozLazyGetService("mozIStorageService", "@mozilla.org/storage/service;1", "mozIStorageService");
mozLazyGetService("mozClipboardHelper", "@mozilla.org/widget/clipboardhelper;1", "nsIClipboardHelper");
mozLazyGetService("mozPromptService", "@mozilla.org/embedcomp/prompt-service;1", "nsIPromptService");
mozLazyGetService("mozRandomGenerator", "@mozilla.org/security/random-generator;1", "nsIRandomGenerator");

function alert(msg) {
	mozPromptService.alert(null, 'MEGA Filelink', msg);
}
function mozRunAsync(f) {
	Services.tm.currentThread.dispatch(f, Ci.nsIEventTarget.DISPATCH_NORMAL);
}
function mozCloseStream(s) {
	if (s instanceof Ci.nsISafeOutputStream) {
		try {
			s.finish();
			return;
		} catch (e) {
			ERR(e);
		}
	}
	s.close();
}

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsMEGA]);