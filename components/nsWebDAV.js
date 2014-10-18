/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2012 */

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/gloda/log4moz.js");
Cu.import("resource:///modules/cloudFileAccounts.js");

function nsWebDAV() {
    this.log = Log4Moz.getConfiguredLogger("FileLinkWebDAV");
    this._uploads = {};
}

nsWebDAV.prototype = {
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIMsgCloudFileProvider]),
  classID: Components.ID("{57c44a6d-2ffd-4554-8157-a592f8361176}"),

  get type() "WebDAV",
  get displayName() "WebDAV",
  get serviceURL() this._baseURL,
  get iconClass() "chrome://cloudfile-webdav/skin/webdav_16.png",
  get accountKey() this._accountKey,
  get lastError() this._lastError,
  get settingsURL() "chrome://cloudfile-webdav/content/settings.xhtml",
  get managementURL() "chrome://cloudfile-webdav/content/management.xhtml",

  get fileUploadSizeLimit() this._fileSpaceAvailable,
  get remainingFileSpace() this._fileSpaceAvailable,
  get fileSpaceUsed() this._fileSpaceUsed,

  _accountKey: false,
  _fileSpaceUsed: -1,
  _fileSpaceAvailable: -1,
  _lastError: Cr.NS_OK,
  _uploads: null,
  _baseURL: null,

  init: function init(aAccountKey) {
    this._accountKey = aAccountKey;
    this._baseURL = Services.prefs.getCharPref("mail.cloud_files.accounts." +
                                               aAccountKey + ".baseURL");
  },

  uploadFile: function uploadFile(aFile, aCallback) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    try {
      // We are going to upload a file
      const PR_RDONLY = 0x01;
      let fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                      .createInstance(Ci.nsIFileInputStream);
      let bufStream = Cc["@mozilla.org/network/buffered-input-stream;1"]
                        .createInstance(Ci.nsIBufferedInputStream);
      fstream.init(aFile, -1, 0, 0);
      bufStream.init(fstream, aFile.fileSize);

      let self = this;
      let listener = this.createRequestListener(function(channel, httpStatus,
                                                         status, resultLength,
                                                         result) {
        delete self._uploads[channel.originalURI.spec];
        aCallback.onStopRequest(null, null, status);
      }, true);

      let url = this.urlForFile(aFile);
      this.log.info("uploading " + aFile.leafName + " to " + url);
      let channel = this.sendRequest("PUT", url, bufStream,
                                     "application/octet-stream",
                                     null, listener);
      this._uploads[url] = channel;
      aCallback.onStartRequest(null, null);
    } catch (e) {
      this.log.error(e.fileName + ":" + e.lineNumber + ":" + e);
    }
  },

  urlForFile: function urlForFile(aFile) {
    return this._baseURL + aFile.leafName;
  },

  cancelFileUpload: function cancelFileUpload(aFile) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    let url = this.urlForFile(aFile);
    if (url in this._uploads) {
      this.log.info("canceling file upload for " + aFile.leafName);
      this._uploads[url].cancel(Cr.NS_BINDING_ABORTED);
    }
  },

  refreshUserInfo: function nsWebDav_refreshUserInfo(aWithUI, aCallback) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    let self = this;
    let listener = this.createRequestListener(function(channel, httpStatus,
                                                       status, resultLength,
                                                       result) {
      if (Components.isSuccessCode(status) &&
          Math.floor(httpStatus / 100) == 2) {
        let parser = Components.classes["@mozilla.org/xmlextras/domparser;1"]
                     .createInstance(Components.interfaces.nsIDOMParser);
        parser.init(null, channel.URI, null);
        let doc = parser.parseFromBuffer(result, resultLength,
                                         "application/xml");

        let qub = doc.getElementsByTagNameNS("DAV:", "quota-used-bytes");
        self._fileSpaceUsed = qub && qub.length && qub[0].textContent || -1;
        if (self._fileSpaceUsed < 0) self._fileSpaceUsed = -1;

        let qab = doc.getElementsByTagNameNS("DAV:", "quota-available-bytes");
        let fsa = qab && qab.length && qab[0].textContent;
        if (fsa && fsa > -1) {
          self._fileSpaceAvailable = fsa;
        } else if (!fsa && fsa !== 0) {
          self._fileSpaceAvailable = -1;
        } else if (!fsa || fsa < 0) {
          self._fileSpaceAvailable = 0;
        }

        self.log.info("quota responded with " + self._fileSpaceUsed + "kB " +
                      "used, " + self._fileSpaceAvailable + "kB available");
      } else {
        self.log.info("could not retrieve user info " + status);
      }
      aCallback.onStopRequest(null, null, status);
    }, aWithUI);

    this.log.info("requesting user info for " + this._baseURL);
    let body = '<propfind xmlns="DAV:">' +
                 '<prop>' +
                   '<quota-available-bytes/>' +
                   '<quota-used-bytes/>' +
                 '</prop>' +
               '</propfind>';

    this.sendRequest("PROPFIND", this._baseURL, body,
                     "text/xml", { "Depth": 0 }, listener);
  },

  deleteFile: function deleteFile(aFile, aCallback) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    let self = this;
    let listener = this.createRequestListener(function(channel, httpStatus,
                                                       status, resultLength,
                                                       result) {
      aCallback.onStopRequest(null, null, status);
    }, true);

    let url = this.urlForFile(aFile);
    this.log.info("deleting " + aFile.leafName + " at " + url);
    this.sendRequest("DELETE", url, null, null, null, listener);
    aCallback.onStartRequest(null, null);
  },

  createNewAccount: function createNewAccount() {
    throw Cr.NS_ERROR_NOT_IMPLEMENTED;
  },
  createExistingAccount: function createExistingAccount(aCallback) {
    if (Services.io.offline) {
      throw Ci.nsIMsgCloudFileProvider.offlineErr;
    }

    this.log.info("checking " + this._baseURL + " for a valid DAV collection");
    let self = this;
    let listener = this.createRequestListener(function(channel, httpStatus,
                                                       status, resultLength,
                                                       result) {
      if (Components.isSuccessCode(status) &&
          Math.floor(httpStatus / 100) == 2) {
        let parser = Components.classes["@mozilla.org/xmlextras/domparser;1"]
                     .createInstance(Components.interfaces.nsIDOMParser);
        parser.init(null, channel.URI, null);
        let doc = parser.parseFromBuffer(result, resultLength,
                                         "application/xml");
        let rtype = doc.getElementsByTagNameNS("DAV:", "resourcetype");
        rtype = rtype && rtype.length && rtype[0].firstChild &&
                  rtype[0].firstChild.localName || "unknown";
        self.log.info(self._baseURL + " is a " + rtype);
        if (rtype != "collection") {
          status = Cr.NS_ERROR_FAILURE;
        }
      }
      aCallback.onStopRequest(null, self, status);
    }, true);

    let uri;
    try {
      Services.io.newURI(this._baseURL, null, null)
    } catch (e) {
      this.log.error(this._baseURL + " is not a valid URI");
      aCallback.onStopRequest(null, this, e.result);
      return;
    }

    let body = '<propfind xmlns="DAV:">' +
                 '<prop>' +
                   '<resourcetype/>' +
                 '</prop>' +
               '</propfind>';

    this.sendRequest("PROPFIND", this._baseURL, body,
                     "text/xml", { "Depth": 0 }, listener);
    aCallback.onStartRequest(null, null);
  },
  providerUrlForError: function providerUrlForError(aError) null,
  get createNewAccountUrl() null,

  overrideUrls: function overrideUrls(aNumUrls, aUrls) {
  },

  sendRequest: function sendRequest(aMethod, aURLString, aUploadData,
                                    aUploadCtype, aHeaders, aListener) {
    let uri = Services.io.newURI(aURLString, null, null)
    let channel = Services.io.newChannelFromURI(uri);

    if (aUploadData) {
      let stream = aUploadData;
      if (typeof aUploadData == "string") {
        stream = Cc["@mozilla.org/io/string-input-stream;1"]
                   .createInstance(Ci.nsIStringInputStream);
        stream.setData(aUploadData, aUploadData.length);
      }

      let uploadChannel = channel.QueryInterface(Ci.nsIUploadChannel);
      uploadChannel.setUploadStream(stream, aUploadCtype, -1);
    }

    // set method
    let httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
    httpChannel.requestMethod = aMethod;

    // Set up headers
    if (aHeaders) {
      for (let key in aHeaders) {
        httpChannel.setRequestHeader(key, aHeaders[key], false);
      }
    }

    channel.notificationCallbacks = aListener;
    let streamLoader = Cc["@mozilla.org/network/stream-loader;1"]
                         .createInstance(Ci.nsIStreamLoader);
    streamLoader.init(aListener);
    channel.asyncOpen(streamLoader, this);
    return channel;
  },

  createRequestListener: function createRequestListener(onComplete, aWithUI) {
    let log = this.log;
    return {
      QueryInterface: XPCOMUtils.generateQI([
        Ci.nsIRequestObserver,
        Ci.nsIStreamLoaderObserver,
        Ci.nsIInterfaceRequestor
      ]),
      onStreamComplete: function(loader, ctxt, status, resultLength, result) {
        let httpStatus = 0;
        if (Components.isSuccessCode(status)) {
          try {
            let httpChannel = loader.request.QueryInterface(Ci.nsIHttpChannel);
            httpStatus = httpChannel.responseStatus;
            let str, logMethod = "info";

            if (Math.floor(httpStatus / 100) == 2) {
                // Success, no need to log anything special
            } else if (httpStatus == 401 || httpStatus == 403) {
              status = Ci.nsIMsgCloudFileProvider.authErr;
              str = "authentication failed";
            } else if (httpStatus == 507) {
              status = Ci.nsIMsgCloudFileProvider.uploadWouldExceedQuota;
              str = "quota exceeded";
            } else {
                try {
                  let conv = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                               .createInstance(Ci.nsIScriptableUnicodeConverter);
                  conv.charset = loader.request.contentCharset || "UTF-8";
                  str = conv.convertFromByteArray(result, result.length);
                } catch (e) {
                  str = e;
                }
                logMethod = "error";
                status = Ci.nsIMsgCloudFileProvider.uploadErr;
            }
            log[logMethod]("request to " + loader.request.URI.spec +
                      " responded with status "  + httpStatus + " " +
                      httpChannel.responseStatusText + (str ? ": " + str : ""));
          } catch(e) {
            log.info("error getting response code: " + e);
          }
        } else if (status == Cr.NS_BINDING_ABORTED) {
          log.info("upload was canceled");
          status = Ci.nsIMsgCloudFileProvider.uploadCanceled;
        } else {
          log.error("unknown error " + status);
          status = Ci.nsIMsgCloudFileProvider.uploadErr;
        }

        onComplete(loader.request, httpStatus, status, resultLength, result);
      },

      getInterface: function gi(aIID) {
        if (aIID.equals(Ci.nsIAuthPrompt2) ||
            aIID.equals(Ci.nsIAuthPromptProvider)) {
          return createAuthPrompt(aWithUI);
        }
        Components.returnCode = Cr.NS_NOINTERFACE;
        return null;
      }
    }
  }
};

function createAuthPrompt(aWithUI) {
  return {
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIAuthPrompt2]),

    promptAuth: function(aChannel, aLevel, aAuthInfo) {
      let hostRealm = {};
      hostRealm.prePath = aChannel.URI.prePath;
      hostRealm.realm = aAuthInfo.realm;
      let port = aChannel.URI.port;
      if (port == -1) {
        let handler = Services.io.getProtocolHandler(aChannel.URI.scheme)
                                 .QueryInterface(Ci.nsIProtocolHandler);
        port = handler.defaultPort;
      }
      hostRealm.passwordRealm = aChannel.URI.host + ":" + port +
                                " (" + aAuthInfo.realm + ")";

      let logins = Services.logins.findLogins({}, hostRealm.prePath,
                                              null, hostRealm.realm);
      if (logins.length) {
        aAuthInfo.username = logins[0].username;
        aAuthInfo.password = logins[0].password;
        return true;
      } else if (!aWithUI) {
        // No UI is allowed, return false
        return false;
      } else {
        return Cc["@mozilla.org/passwordmanager/authpromptfactory;1"]
                 .getService(Ci.nsIPromptFactory)
                 .getPrompt(null, Ci.nsIAuthPrompt2)
                 .promptAuth(aChannel, aLevel, aAuthInfo);
      }
    },

    asyncPromptAuth: function(aChannel, aCallback, aContext,
                              aLevel, aAuthInfo) {
      let self = this;
      let promptListener = {
        onPromptStart: function() {
          let res = self.promptAuth(aChannel, aLevel, aAuthInfo);
          if (res) {
            this.onPromptAuthAvailable();
          } else {
            this.onPromptCanceled();
          }
          return res;
        },
        onPromptAuthAvailable: function() {
          aCallback.onAuthAvailable(aContext, aAuthInfo);
        },
        onPromptCanceled: function() {
          aCallback.onAuthCancelled(aContext, true);
        }
      };

      let asyncprompter = Cc["@mozilla.org/messenger/msgAsyncPrompter;1"]
                            .getService(Ci.nsIMsgAsyncPrompter);
      asyncprompter.queueAsyncAuthPrompt(aChannel.URI.spec, false,
                                         promptListener);
    },

    getAuthPrompt: function(aReason, aIID) {
      return this.QueryInterface(aIID);
    }
  };
}

const NSGetFactory = XPCOMUtils.generateNSGetFactory([nsWebDAV]);
