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

you can also send the merged flow by mqtt at each deploy, for example in the `settings.js`:

```js
module.exports = {
    // ...
	noderedLocalfilesystemOneFilePerTab: {
		mqttBroker: "mqtt://localhost:1883",
		mqttPublishTopic: "test/flows"
	}
	// ...
```

NB: mqttPublishTopic can be an array of string to publish to different topics

in addition to the previous option, you can add mqtt topic trigger to send the merged flow when messages are published on it (ex: topic where something publishes at boot), for example in the `settings.js`:

```js
module.exports = {
    // ...
	noderedLocalfilesystemOneFilePerTab: {
		// ...
		mqttSubscribeTopic: ["test/boot", "test2/start"]
		// ...
	}
	// ...
```

NB: mqttSubscribeTopic can be a string to subscribe on only 1 topic