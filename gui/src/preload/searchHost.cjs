



































































"use strict";

var electron = require("electron");
var contextBridge = electron.contextBridge;
var ipcRenderer = electron.ipcRenderer;


var CH = /*__SLIME_CHANNELS__*/ null;


var HOST_NAME = "slime 浏览器内核";


var LOCAL_HOSTS = { "127.0.0.1": 1, localhost: 1, "::1": 1, "[::1]": 1 };






function isLocalDocument() {
  try {
    var proto = location.protocol;
    if (proto === "file:" || proto === "about:") { return true; }
    if (proto === "http:" || proto === "https:") { return !!LOCAL_HOSTS[location.hostname]; }
    return false;
  } catch (e) {
    return false;
  }
}

if (CH && isLocalDocument()) {
  contextBridge.exposeInMainWorld("SlimeBrowserHost", {
    name: HOST_NAME,

    
    query: function (q) {
      return ipcRenderer.invoke(CH.search_query, { query: String(q == null ? "" : q) });
    },

    
    notify: function (evt) {
      try { ipcRenderer.send(CH.search_event, evt); } catch (e) {  }
    },

    
    onTheme: function (cb) {
      if (typeof cb !== "function") { return; }
      ipcRenderer.on(CH.search_theme, function (_e, mode) {
        try { cb(mode); } catch (e) {  }
      });
    },

    
    getTheme: function () {
      return ipcRenderer.invoke(CH.search_theme_get);
    },

    
    reportTheme: function (detail) {
      try { ipcRenderer.send(CH.search_theme_report, detail); } catch (e) {  }
    }
  });
}
