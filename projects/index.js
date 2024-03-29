/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

var fs = require('fs-extra');
var simplefs = require('fs');
var when = require('when');
var fspath = require("path");
var nodeFn = require('when/node/function');
var crypto = require('crypto');
var mqtt = require('mqtt');

var storageSettings = require("../settings");
var util = require("../util");
var gitTools = require("./git");
var sshTools = require("./ssh");

var Projects = require("./Project");

var settings;
var runtime;
var log;

var projectsEnabled = false;
var projectLogMessages = [];

var projectsDir;
var activeProject

var globalGitUser = false;

var mqttClient;
var mqttConnected;

var sortFlows = false;

var tablessNodes = {};

var flowsFileList = {};
function addFlowFile(file){
    var p = fspath.resolve(file);
    if(!flowsFileList[p]) {
        flowsFileList[p] = [];
    }
}

function getLocalFlowsFiles(dir){
    var files = [];
    try {
        files = fs.readdirSync(dir);
    }
    catch(err) {
        return;
    }
    files.sort();
    files.forEach(function(fn) {
        var stats = fs.statSync(fspath.join(dir,fn));
        if (stats.isFile() && /\.flows.json$/.test(fn)) {
            addFlowFile(fspath.join(dir, fn));
        }else if (stats.isDirectory()) {
            getLocalFlowsFiles(fspath.join(dir,fn));
        }
    });
}

function init(_settings, _runtime) {
    settings = _settings;
    runtime = _runtime;
    log = runtime.log;

    try {
        if (settings.editorTheme.projects.enabled === true) {
            projectsEnabled = true;
        } else if (settings.editorTheme.projects.enabled === false) {
            projectLogMessages.push(log._("storage.localfilesystem.projects.disabled"))
        }
    } catch(err) {
        projectLogMessages.push(log._("storage.localfilesystem.projects.disabledNoFlag"))
        projectsEnabled = false;
    }

    if (settings.flowFile) {
        flowsFile = settings.flowFile;
        // handle Unix and Windows "C:\"
        if ((flowsFile[0] == "/") || (flowsFile[1] == ":")) {
            // Absolute path
            flowsFullPath = flowsFile;
        } else if (flowsFile.substring(0,2) === "./") {
            // Relative to cwd
            flowsFullPath = fspath.join(process.cwd(),flowsFile);
        } else {
            try {
                fs.statSync(fspath.join(process.cwd(),flowsFile));
                // Found in cwd
                flowsFullPath = fspath.join(process.cwd(),flowsFile);
            } catch(err) {
                // Use userDir
                flowsFullPath = fspath.join(settings.userDir,flowsFile);
            }
        }

    } else {
        flowsFile = 'flows_'+require('os').hostname()+'.json';
        flowsFullPath = fspath.join(settings.userDir,flowsFile);
    }
    var ffExt = fspath.extname(flowsFullPath);
    var ffBase = fspath.basename(flowsFullPath,ffExt);

    flowsFileBackup = getBackupFilename(flowsFullPath);
    credentialsFile = fspath.join(settings.userDir,ffBase+"_cred"+ffExt);
    credentialsFileBackup = getBackupFilename(credentialsFile)

    if(settings.userDir){
        getLocalFlowsFiles(fspath.join(settings.userDir,"flows"));
    }
	
	if (typeof settings.noderedLocalfilesystemOneFilePerTab == "object") {
		var protocol = "mqtt";
		var mqttSecure = settings.noderedLocalfilesystemOneFilePerTab.mqttSecure || false;
		var mqttBroker = settings.noderedLocalfilesystemOneFilePerTab.mqttBroker || "mosquitto";
		var mqttPort = settings.noderedLocalfilesystemOneFilePerTab.mqttPort || 1883;
		var mqttUsername = settings.noderedLocalfilesystemOneFilePerTab.mqttUsername;
		var mqttPassword = settings.noderedLocalfilesystemOneFilePerTab.mqttPassword;
		
		var options = {};
		
		var url = protocol;
		if (mqttSecure) {
			url += 's';
			//TODO: should add & verify certificate
			options.rejectUnauthorized = false;
		}
		url += "://";
		if (mqttUsername) {
			url += mqttUsername;
			if (mqttPassword) {
				url += ':' + mqttPassword;
			}
			url += '@';
		}	
		url += mqttBroker + ':' + mqttPort;
		
		if (mqttBroker) {
			mqttClient = mqtt.connect(url, options);
			
			mqttClient.on('connect', function() {
				mqttConnected = true;
				var mqttSubscribeTopic = settings.noderedLocalfilesystemOneFilePerTab.mqttSubscribeTopic;
				
				if (mqttSubscribeTopic && mqttSubscribeTopic.length > 0) {
					if (typeof mqttSubscribeTopic == "string") {
						mqttClient.subscribe(mqttSubscribeTopic, function(err) {
							if (err) {
								console.log("Can't connect to topic " + mqttSubscribeTopic);
								console.log(err);
							}
						});
					}
					else if (Array.isArray(mqttSubscribeTopic)) {
						for (var i=0; i<mqttSubscribeTopic.length; i++) {
							mqttClient.subscribe(mqttSubscribeTopic[i], function(err) {
								if (err) {
									console.log("Can't connect to topic " + mqttSubscribeTopic[i]);
									console.log(err);
								}
							});
						}
					}
					
					mqttClient.on('message', function(topic, message) {
						getFlows().then(function(flows) {
							sendFlowsOnMqtt(flows);
						});
					});
				}
			});
		}
		
		if (typeof settings.noderedLocalfilesystemOneFilePerTab.sortFlows === 'boolean') {
			sortFlows = settings.noderedLocalfilesystemOneFilePerTab.sortFlows;
		}
	}

    var setupProjectsPromise;

    if (projectsEnabled) {
        return sshTools.init(settings,runtime).then(function() {
            gitTools.init(_settings, _runtime).then(function(gitConfig) {
                if (!gitConfig || /^1\./.test(gitConfig.version)) {
                    if (!gitConfig) {
                        projectLogMessages.push(log._("storage.localfilesystem.projects.git-not-found"))
                    } else {
                        projectLogMessages.push(log._("storage.localfilesystem.projects.git-version-old",{version:gitConfig.version}))
                    }
                    projectsEnabled = false;
                    try {
                        // As projects have to be turned on, we know this property
                        // must exist at this point, so turn it off.
                        // TODO: when on-by-default, this will need to do more
                        // work to disable.
                        settings.editorTheme.projects.enabled = false;
                    } catch(err) {
                    }
                } else {
                    globalGitUser = gitConfig.user;
                    Projects.init(settings,runtime);
                    sshTools.init(settings,runtime);
                    projectsDir = fspath.join(settings.userDir,"projects");
                    if (!settings.readOnly) {
                        return fs.ensureDir(projectsDir)
                        //TODO: this is accessing settings from storage directly as settings
                        //      has not yet been initialised. That isn't ideal - can this be deferred?
                        .then(storageSettings.getSettings)
                        .then(function(globalSettings) {
                            var saveSettings = false;
                            if (!globalSettings.projects) {
                                globalSettings.projects = {
                                    projects: {}
                                }
                                saveSettings = true;
                            } else {
                                activeProject = globalSettings.projects.activeProject;
                            }
                            if (settings.flowFile) {
                                // if flowFile is a known project name - use it
                                if (globalSettings.projects.projects.hasOwnProperty(settings.flowFile)) {
                                    activeProject = settings.flowFile;
                                    globalSettings.projects.activeProject = settings.flowFile;
                                    saveSettings = true;
                                } else {
                                    // if it resolves to a dir - use it... but:
                                    // - where to get credsecret from?
                                    // - what if the name clashes with a known project?
                                    
                                    // var stat = fs.statSync(settings.flowFile);
                                    // if (stat && stat.isDirectory()) {
                                    //     activeProject = settings.flowFile;
                                    // }
                                }
                            }
                            if (!activeProject) {
                                projectLogMessages.push(log._("storage.localfilesystem.no-active-project"))
                            }
                            if (saveSettings) {
                                return storageSettings.saveSettings(globalSettings);
                            }
                        });
                    }
                }
            });
        });
    }
    return Promise.resolve();
}

function listProjects() {
    return fs.readdir(projectsDir).then(function(fns) {
        var dirs = [];
        fns.sort(function(A,B) {
            return A.toLowerCase().localeCompare(B.toLowerCase());
        }).filter(function(fn) {
            var fullPath = fspath.join(projectsDir,fn);
            if (fn[0] != ".") {
                var stats = fs.lstatSync(fullPath);
                if (stats.isDirectory()) {
                    dirs.push(fn);
                }
            }
        });
        return dirs;
    });
}

function getUserGitSettings(user) {
    var userSettings = settings.getUserSettings(user)||{};
    return userSettings.git;
}

function getBackupFilename(filename) {
    var ffName = fspath.basename(filename);
    var ffDir = fspath.dirname(filename);
    return fspath.join(ffDir,"."+ffName+".backup");
}

function loadProject(name) {
    var projectPath = name;
    if (projectPath.indexOf(fspath.sep) === -1) {
        projectPath = fspath.join(projectsDir,name);
    }
    return Projects.load(projectPath).then(function(project) {
        activeProject = project;
        flowsFullPath = project.getFlowFile();
        flowsFileBackup = project.getFlowFileBackup();
        credentialsFile = project.getCredentialsFile();
        credentialsFileBackup = project.getCredentialsFileBackup();
        return project;
    })
}

function getProject(user, name) {
    checkActiveProject(name);
    //return when.resolve(activeProject.info);
    return Promise.resolve(activeProject.export());
}

function deleteProject(user, name) {
    if (activeProject && activeProject.name === name) {
        var e = new Error("NLS: Can't delete the active project");
        e.code = "cannot_delete_active_project";
        throw e;
    }
    var projectPath = fspath.join(projectsDir,name);
    return Projects.delete(user, projectPath);
}

function checkActiveProject(project) {
    if (!activeProject || activeProject.name !== project) {
        //TODO: throw better err
        throw new Error("Cannot operate on inactive project wanted:"+project+" current:"+(activeProject&&activeProject.name));
    }
}
function getFiles(user, project) {
    checkActiveProject(project);
    return activeProject.getFiles();
}
function stageFile(user, project,file) {
    checkActiveProject(project);
    return activeProject.stageFile(file);
}
function unstageFile(user, project,file) {
    checkActiveProject(project);
    return activeProject.unstageFile(file);
}
function commit(user, project,options) {
    checkActiveProject(project);
    var isMerging = activeProject.isMerging();
    return activeProject.commit(user, options).then(function() {
        // The project was merging, now it isn't. Lets reload.
        if (isMerging && !activeProject.isMerging()) {
            return reloadActiveProject("merge-complete");
        }
    })
}
function getFileDiff(user, project,file,type) {
    checkActiveProject(project);
    return activeProject.getFileDiff(file,type);
}
function getCommits(user, project,options) {
    checkActiveProject(project);
    return activeProject.getCommits(options);
}
function getCommit(user, project,sha) {
    checkActiveProject(project);
    return activeProject.getCommit(sha);
}

function getFile(user, project,filePath,sha) {
    checkActiveProject(project);
    return activeProject.getFile(filePath,sha);
}
function revertFile(user, project,filePath) {
    checkActiveProject(project);
    return activeProject.revertFile(filePath).then(function() {
        return reloadActiveProject("revert");
    })
}
function push(user, project,remoteBranchName,setRemote) {
    checkActiveProject(project);
    return activeProject.push(user,remoteBranchName,setRemote);
}
function pull(user, project,remoteBranchName,setRemote,allowUnrelatedHistories) {
    checkActiveProject(project);
    return activeProject.pull(user,remoteBranchName,setRemote,allowUnrelatedHistories).then(function() {
        return reloadActiveProject("pull");
    });
}
function getStatus(user, project, includeRemote) {
    checkActiveProject(project);
    return activeProject.status(user, includeRemote);
}
function resolveMerge(user, project,file,resolution) {
    checkActiveProject(project);
    return activeProject.resolveMerge(file,resolution);
}
function abortMerge(user, project) {
    checkActiveProject(project);
    return activeProject.abortMerge().then(function() {
        return reloadActiveProject("merge-abort")
    });
}
function getBranches(user, project,isRemote) {
    checkActiveProject(project);
    return activeProject.getBranches(user, isRemote);
}

function deleteBranch(user, project, branch, isRemote, force) {
    checkActiveProject(project);
    return activeProject.deleteBranch(user, branch, isRemote, force);
}

function setBranch(user, project,branchName,isCreate) {
    checkActiveProject(project);
    return activeProject.setBranch(branchName,isCreate).then(function() {
        return reloadActiveProject("change-branch");
    });
}
function getBranchStatus(user, project,branchName) {
    checkActiveProject(project);
    return activeProject.getBranchStatus(branchName);
}


function getRemotes(user, project) {
    checkActiveProject(project);
    return activeProject.getRemotes(user);
}
function addRemote(user, project, options) {
    checkActiveProject(project);
    return activeProject.addRemote(user, options.name, options);
}
function removeRemote(user, project, remote) {
    checkActiveProject(project);
    return activeProject.removeRemote(user, remote);
}
function updateRemote(user, project, remote, body) {
    checkActiveProject(project);
    return activeProject.updateRemote(user, remote, body);
}

function getActiveProject(user) {
    return activeProject;
}

function reloadActiveProject(action) {
    return runtime.nodes.stopFlows().then(function() {
        return runtime.nodes.loadFlows(true).then(function() {
            runtime.events.emit("runtime-event",{id:"project-update", payload:{ project: activeProject.name, action:action}});
        }).catch(function(err) {
            // We're committed to the project change now, so notify editors
            // that it has changed.
            runtime.events.emit("runtime-event",{id:"project-update", payload:{ project: activeProject.name, action:action}});
            throw err;
        });
    });
}
function createProject(user, metadata) {
    // var userSettings = getUserGitSettings(user);
    if (metadata.files && metadata.migrateFiles) {
        // We expect there to be no active project in this scenario
        if (activeProject) {
            throw new Error("Cannot migrate as there is an active project");
        }
        var currentEncryptionKey = settings.get('credentialSecret');
        if (currentEncryptionKey === undefined) {
            currentEncryptionKey = settings.get('_credentialSecret');
        }
        if (!metadata.hasOwnProperty('credentialSecret')) {
            metadata.credentialSecret = currentEncryptionKey;
        }
        if (!metadata.files.flow) {
            metadata.files.flow = fspath.basename(flowsFullPath);
        }
        if (!metadata.files.credentials) {
            metadata.files.credentials = fspath.basename(credentialsFile);
        }

        metadata.files.oldFlow = flowsFullPath;
        metadata.files.oldCredentials = credentialsFile;
        metadata.files.credentialSecret = currentEncryptionKey;
    }
    metadata.path = fspath.join(projectsDir,metadata.name);
    return Projects.create(user, metadata).then(function(p) {
        return setActiveProject(user, p.name);
    }).then(function() {
        return getProject(user, metadata.name);
    })
}
function setActiveProject(user, projectName) {
    return loadProject(projectName).then(function(project) {
        var globalProjectSettings = settings.get("projects");
        globalProjectSettings.activeProject = project.name;
        return settings.set("projects",globalProjectSettings).then(function() {
            log.info(log._("storage.localfilesystem.projects.changing-project",{project:(activeProject&&activeProject.name)||"none"}));
            log.info(log._("storage.localfilesystem.flows-file",{path:flowsFullPath}));
            // console.log("Updated file targets to");
            // console.log(flowsFullPath)
            // console.log(credentialsFile)
            return reloadActiveProject("loaded");
        })
    });
}

function initialiseProject(user, project, data) {
    if (!activeProject || activeProject.name !== project) {
        // TODO standardise
        throw new Error("Cannot initialise inactive project");
    }
    return activeProject.initialise(user,data).then(function(result) {
        flowsFullPath = activeProject.getFlowFile();
        flowsFileBackup = activeProject.getFlowFileBackup();
        credentialsFile = activeProject.getCredentialsFile();
        credentialsFileBackup = activeProject.getCredentialsFileBackup();
        runtime.nodes.setCredentialSecret(activeProject.credentialSecret);
        return reloadActiveProject("updated");
    });
}
function updateProject(user, project, data) {
    if (!activeProject || activeProject.name !== project) {
        // TODO standardise
        throw new Error("Cannot update inactive project");
    }
    // In case this triggers a credential secret change
    var isReset = data.resetCredentialSecret;
    var wasInvalid = activeProject.credentialSecretInvalid;

    return activeProject.update(user,data).then(function(result) {

        if (result.flowFilesChanged) {
            flowsFullPath = activeProject.getFlowFile();
            flowsFileBackup = activeProject.getFlowFileBackup();
            credentialsFile = activeProject.getCredentialsFile();
            credentialsFileBackup = activeProject.getCredentialsFileBackup();
            return reloadActiveProject("updated");
        } else if (result.credentialSecretChanged) {
            if (isReset || !wasInvalid) {
                if (isReset) {
                    runtime.nodes.clearCredentials();
                }
                runtime.nodes.setCredentialSecret(activeProject.credentialSecret);
                return runtime.nodes.exportCredentials()
                    .then(runtime.storage.saveCredentials)
                    .then(function() {
                        if (wasInvalid) {
                            return reloadActiveProject("updated");
                        }
                    });
            } else if (wasInvalid) {
                return reloadActiveProject("updated");
            }
        }
    });
}
function setCredentialSecret(data) { //existingSecret,secret) {
    var isReset = data.resetCredentialSecret;
    var wasInvalid = activeProject.credentialSecretInvalid;
    return activeProject.update(data).then(function() {
        if (isReset || !wasInvalid) {
            if (isReset) {
                runtime.nodes.clearCredentials();
            }
            runtime.nodes.setCredentialSecret(activeProject.credentialSecret);
            return runtime.nodes.exportCredentials()
                .then(runtime.storage.saveCredentials)
                .then(function() {
                    if (wasInvalid) {
                        return reloadActiveProject("updated");
                    }
                });
        } else if (wasInvalid) {
            return reloadActiveProject("updated");
        }
    })
}


var initialFlowLoadComplete = false;

var flowsFile;
var flowsFullPath;
var flowsFileExists = false;
var flowsFileBackup;
var credentialsFile;
var credentialsFileBackup;

function sendFlowsOnMqtt(flows) {
	if (mqttConnected) {
		var mqttPublishTopic = settings.noderedLocalfilesystemOneFilePerTab.mqttPublishTopic;
		
		if (mqttPublishTopic && mqttPublishTopic.length > 0) {
			if (typeof mqttPublishTopic == "string" ) {
				mqttClient.publish(mqttPublishTopic, JSON.stringify(flows));
			}
			else if (Array.isArray(mqttPublishTopic)) {
				for (var i=0; i<mqttPublishTopic.length; i++) {
					mqttClient.publish(mqttPublishTopic[i], JSON.stringify(flows));
				}
			}
		}
	}
}

//TODO what if a same node id has 2 different values but no '_ts' value ?
//TODO what if a node is without "z" here but has a "z" in an imported flow ?
//TODO export/import from client isn't handled, it needs to use storage files, not client flows

//if a new tab is added directly in flows directory without using export/import from client,
//it needs to be deployed once to propagate nodes in other tabs
function addNewTablessNode(n) {
	let id = n.id;

	if (!tablessNodes[id]) {
		if (!n._ts) {
			n._ts = 0;
		}
		tablessNodes[id] = n;
	}
	else if (n._ts && n._ts > tablessNodes[id]._ts) {
		tablessNodes[id] = n;
	}
}

function getFlows() {
    return when.promise(function(resolve) {
        if (!initialFlowLoadComplete) {
            initialFlowLoadComplete = true;
            log.info(log._("storage.localfilesystem.user-dir",{path:settings.userDir}));
            if (activeProject) {                
                // At this point activeProject will be a string, so go load it and
                // swap in an instance of Project
                return loadProject(activeProject).then(function() {
                    log.info("Flows files :");
                    console.log("\t\t\t From project", (activeProject.name||"none"),":");
                    console.log("\t\t\t\t - ", flowsFullPath);
                    return getFlows().then(resolve);
                });
            } else {
                if (projectsEnabled) {
                    log.warn(log._("storage.localfilesystem.projects.no-active-project"))
                } else {
                    projectLogMessages.forEach(log.warn);
                }
                log.info("Flows files :");
                console.log("\t\t\t From", log._("storage.localfilesystem.user-dir"));
                console.log("\t\t\t\t - ", flowsFullPath);
            }
        }
        if(flowsFileList > 0){
            console.log("\t\t\t From ${fspath.join(settings.userDir, 'flows')} :");
        }
        for(var i in flowsFileList) {
            console.log("\t\t\t\t - ", i);
        }
        if (activeProject) {
            var error;
            if (activeProject.isEmpty()) {
                log.warn("Project repository is empty");
                error = new Error("Project repository is empty");
                error.code = "project_empty";
                return when.reject(error);
            }
            if (activeProject.missingFiles && activeProject.missingFiles.indexOf('package.json') !== -1) {
                log.warn("Project missing package.json");
                error = new Error("Project missing package.json");
                error.code = "missing_package_file";
                return when.reject(error);
            }
            if (!activeProject.getFlowFile()) {
                log.warn("Project has no flow file");
                error = new Error("Project has no flow file");
                error.code = "missing_flow_file";
                return when.reject(error);
            }
            if (activeProject.isMerging()) {
                log.warn("Project has unmerged changes");
                error = new Error("Project has unmerged changes. Cannot load flows");
                error.code = "git_merge_conflict";
                return when.reject(error);
            }

        }

        flowsFileExists = true;
        var promises = [];
        promises.push(util.readFile(flowsFullPath, flowsFileBackup, [], 'flow', false));
        for(var i in flowsFileList) {
            promises.push(util.readFile(i, getBackupFilename(i), [], 'flow', true));
        }
        when.settle(promises).then(function(descriptors) {
            var flows = [];
			
            for(var i in descriptors) {
				let value = descriptors[i].value;
				let j = value.length - 1;
				
				while (j >= 0) {
					let n = value[j];
					if (!n || typeof n !== "object") {
						value.pop();
						j -= 1;
					}
					else if (n.type !== "tab" && n.type !== "subflow" && !n.z) {
						addNewTablessNode(value.pop());
						j -= 1;
					}
					else {
						break;
					}
				}
				
                Array.prototype.push.apply(flows, value);
            }
			
			let tnKeys = Object.keys(tablessNodes);
			for (let id of tnKeys) {
				flows.push(tablessNodes[id]);
			}
			
            resolve(flows);
        });
    });
}

function addTablessNodesToFlow(tab, tnToAdd = [], loop = 2) {
	if (!Array.isArray(tab) || typeof tablessNodes != "object") {
		return;
	}
	
	let sTab = "";
	let tnKeys = Object.keys(tablessNodes);
	
	try {
		sTab = JSON.stringify(tab);
		sTab += JSON.stringify(tnToAdd);
	} catch (e) {}
	
	let modified = false;
	for (let id of tnKeys) {
		if (tnToAdd.indexOf(tablessNodes[id]) == -1 && sTab.includes(id)) {
			tnToAdd.push(tablessNodes[id]);
			modified = true;
		}
	}
	
	if (modified && loop > 0) {
		addTablessNodesToFlow(tab, tnToAdd, --loop);
	}
	else {
		Array.prototype.push.apply(tab, tnToAdd);
	}
}

//sort elements
function sort(elems, fields, order = 1) {
    if (!Array.isArray(elems)) {
        return [];
    }
    if (!Array.isArray(fields)) {
        fields = [fields];
    }
    if (order !== -1 && order !== 1) {
        order = 1;
    }

    return elems.sort(function (a, b) {
        for (let i=0, max=fields.length; i<max; i++) {
            const field = fields[i];
            if (a[field] > b[field] || (a[field] === undefined && b[field] !== undefined)) {
                return order;
            }
            else if (a[field] < b[field] || (a[field] !== undefined && b[field] === undefined)) {
                return -(order);
            }
            else if (i === fields.length - 1) {
                return 0;
            }
        }
    });
}

function saveFlows(flows) {
    if (settings.readOnly) {
        return when.resolve();
    }
    if (activeProject && activeProject.isMerging()) {
        var error = new Error("Project has unmerged changes. Cannot deploy new flows");
        error.code = "git_merge_conflict";
        return when.reject(error);
    }

    flowsFileExists = true;
    
    return when.promise(function(resolve, reject) {
        var tab = [];
        var name;
        var tabName = []
        var promises = [];

        var flowData, flowsFullPath, flowsFileBackup, tabUsed;
            
        flowsFileList = [];
        getLocalFlowsFiles(settings.userDir);

        for(var flow in flows) {
            var n = flows[flow];
            if(n.type === "tab" || n.type === "subflow") {
                if (!tab.hasOwnProperty(n.id)) {
                    tab[n.id] = [];
                }
                name = n.label || n.name;
                name = name.replace(/[?\/\\*:><" ,-]+/g,'-');
                tabName[n.id] = name +"/";
                tab[n.id].push(n);
            } else if (n.hasOwnProperty("z") && n.z) {
                if (!tab.hasOwnProperty(n.z)) {
                    tab[n.z] = [];
                }
                tab[n.z].push(n);
            } else {
				let nString = "";
				let tnString = "";
				
				try {
					nString = JSON.stringify(n);
					
					//TODO: get "_ts" from flows instead of removing it from "tablessNodes" after cloning
					let tnTmp = JSON.parse(JSON.stringify(tablessNodes[n.id]));
					delete tnTmp._ts;
					tnString = JSON.stringify(tnTmp);
				} catch (e) {}
				
				if (nString !== tnString) {
					n._ts = Date.now();
				}
				
                addNewTablessNode(n);
            }
        }
		
		var id;
		for (id in tab) {
			addTablessNodesToFlow(tab[id]);
		}

        tabUsed = [];
        
        for(var t in tab) {
			if (sortFlows === true) {
				//sort nodes by z (the ones displayed in the flow first, then config ones) then id
				sort(tab[t], ['z', 'type', 'id'], 1);
				//put "tab" node type in first position
				const tabNodeIndex = tab[t].findIndex(n => {
					return n.type === 'tab' || n.type === 'subflow';
				});
				if (tabNodeIndex !== -1) {
					tab[t].unshift(tab[t].splice(tabNodeIndex, 1)[0]);
				}
			}
			
            if (settings.flowFilePretty){
                flowData = JSON.stringify(tab[t], null, 4);
            } else {
                flowData = JSON.stringify(tab[t]);
            }

            flowsFullPath = fspath.join(settings.userDir, 'flows', tabName[t] + t + ".flows.json");

            if (flowsFileList.hasOwnProperty(flowsFullPath)){
                tabUsed[flowsFullPath] = true;
            } else {
                tabUsed[flowsFullPath] = false;
            }

            promises.push(util.writeFile(flowsFullPath, flowData, getBackupFilename(flowsFullPath)));
        }

        for(var flowsFile in flowsFileList) {
            if (!tabUsed.hasOwnProperty(flowsFile) || tabUsed[flowsFile] === false){
                try {
                    simplefs.unlinkSync(flowsFile);
                    flowsFileList.slice(flowsFile,1);
                } catch (e) {

                }
                    
            } else {                    
            }
        }
		
		sendFlowsOnMqtt(flows);
            
        when.settle(promises).then(function(descriptors) {
            return resolve();
        })
    });
}

function getCredentials() {
    return util.readFile(credentialsFile,credentialsFileBackup,{},'credentials');
}

function saveCredentials(credentials) {
    if (settings.readOnly) {
        return when.resolve();
    }

    var credentialData;
    if (settings.flowFilePretty) {
        credentialData = JSON.stringify(credentials,null,4);
    } else {
        credentialData = JSON.stringify(credentials);
    }
    return util.writeFile(credentialsFile, credentialData, credentialsFileBackup);
}

function getFlowFilename() {
    if (flowsFullPath) {
        return fspath.basename(flowsFullPath);
    }
}
function getCredentialsFilename() {
    if (flowsFullPath) {
        return fspath.basename(credentialsFile);
    }
}

module.exports = {
    init: init,
    listProjects: listProjects,
    getActiveProject: getActiveProject,
    setActiveProject: setActiveProject,
    getProject: getProject,
    deleteProject: deleteProject,
    createProject: createProject,
    initialiseProject: initialiseProject,
    updateProject: updateProject,
    getFiles: getFiles,
    getFile: getFile,
    revertFile: revertFile,
    stageFile: stageFile,
    unstageFile: unstageFile,
    commit: commit,
    getFileDiff: getFileDiff,
    getCommits: getCommits,
    getCommit: getCommit,
    push: push,
    pull: pull,
    getStatus:getStatus,
    resolveMerge: resolveMerge,
    abortMerge: abortMerge,
    getBranches: getBranches,
    deleteBranch: deleteBranch,
    setBranch: setBranch,
    getBranchStatus:getBranchStatus,
    getRemotes: getRemotes,
    addRemote: addRemote,
    removeRemote: removeRemote,
    updateRemote: updateRemote,
    getFlowFilename: getFlowFilename,
    flowFileExists: function() { return flowsFileExists },
    getCredentialsFilename: getCredentialsFilename,
    getGlobalGitUser: function() { return globalGitUser },
    getFlows: getFlows,
    saveFlows: saveFlows,
    getCredentials: getCredentials,
    saveCredentials: saveCredentials,

    ssh: sshTools

};
