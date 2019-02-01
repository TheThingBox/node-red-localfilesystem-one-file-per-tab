It's a fork from localfilesystem Node-RED storage module. It permits to separate each flow tab into separate flow files.

The Node-RED version forked is 0.19.5. It's also fork internal log and i18n Node-RED module from the 0.19.5.

To get the original source looks here:
- https://github.com/node-red/node-red/tree/0.19.5/red/runtime/storage/localfilesystem
- https://github.com/node-red/node-red/blob/0.19.5/red/runtime/i18n.js
- https://github.com/node-red/node-red/blob/0.19.5/red/runtime/log.js
You can also look to the 0.19.5 node-red npm module.

To know more about Node-RED: https://nodered.org/

# How to use it ?

install as a module with npm.

add into Node-RED settings object an instance of this module, for example in the `settings.js`:
```js
var localstorage = require("node-red-localfilesystem-one-file-per-tab"); 

module.exports = {
    // ...
    storageModule: localstorage
    // ...
}
```
