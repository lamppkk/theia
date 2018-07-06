/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { injectable, inject, interfaces, named } from 'inversify';
import { PluginWorker } from '../../main/browser/plugin-worker';
import { HostedPluginServer, PluginMetadata, PluginPackage } from '../../common/plugin-protocol';
import { HostedPluginWatcher } from './hosted-plugin-watcher';
import { MAIN_RPC_CONTEXT, Plugin } from '../../api/plugin-api';
import { setUpPluginApi } from '../../main/browser/main-context';
import { RPCProtocol, RPCProtocolImpl } from '../../api/rpc-protocol';
import { ILogger, ContributionProvider } from '@theia/core';
import { PreferenceServiceImpl, PreferenceContribution, PreferenceSchema, PreferenceScope } from '@theia/core/lib/browser';

@injectable()
export class HostedPluginSupport {
    container: interfaces.Container;
    private worker: PluginWorker;

    @inject(ILogger)
    protected readonly logger: ILogger;

    @inject(HostedPluginServer)
    private readonly server: HostedPluginServer;

    @inject(HostedPluginWatcher)
    private readonly watcher: HostedPluginWatcher;

    // @inject(PreferenceSchemaProvider)
    // private readonly prefChemaProvider: PreferenceSchemaProvider;

    private theiaReadyPromise: Promise<any>;

    private backendApiInitialized = false;
    private frontendApiInitialized = false;

    protected readonly combinedSchema: PreferenceSchema = {properties: {}};

    constructor(
        @inject(PreferenceServiceImpl) private readonly prefService: PreferenceServiceImpl,
        @inject(ContributionProvider) @named(PreferenceContribution)
        protected readonly preferenceContributions: ContributionProvider<PreferenceContribution>
    ) {
        this.theiaReadyPromise = Promise.all([this.prefService.ready]);

        setTimeout(() => {
            this.preferenceContributions.getContributions().forEach(contrib => {
                for (const property in contrib.schema.properties) {
                    if (this.combinedSchema.properties[property]) {
                        this.logger.error("Preference name collision detected in the schema for property: " + property);
                    } else {
                        this.combinedSchema.properties[property] = contrib.schema.properties[property];
                    }
                }
            });
            console.log(this.combinedSchema);
        }, 0);
    }

    checkAndLoadPlugin(container: interfaces.Container): void {
        this.container = container;
        this.initPlugins();
    }

    public initPlugins(): void {
        console.log("init plugins....!");
        this.server.getHostedPlugin().then((pluginMetadata: any) => {
            if (pluginMetadata) {
                this.loadPlugin(pluginMetadata, this.container);
            }
        });

        this.server.getDeployedBackendMetadata().then((pluginMetadata: PluginMetadata[]) => {
            pluginMetadata.forEach(metadata => this.loadPlugin(metadata, this.container));
        });

        this.server.getDeployedFrontendMetadata().then((pluginMetadata: PluginMetadata[]) => {
            pluginMetadata.forEach(metadata => this.loadPlugin(metadata, this.container));
        });

    }

    public loadPlugin(pluginMetadata: PluginMetadata, container: interfaces.Container): void {
        const pluginModel = pluginMetadata.model;
        const pluginLifecycle = pluginMetadata.lifecycle;
        this.logger.info('Ask to load the plugin with model ', pluginModel, ' and lifecycle', pluginLifecycle);
        if (pluginModel.entryPoint!.frontend) {
            this.logger.info(`Loading frontend hosted plugin: ${pluginModel.name}`);
            this.worker = new PluginWorker();

            this.theiaReadyPromise.then(() => {
                const hostedExtManager = this.worker.rpc.getProxy(MAIN_RPC_CONTEXT.HOSTED_PLUGIN_MANAGER_EXT);
                const plugin: Plugin = {
                    pluginPath: pluginModel.entryPoint.frontend!,
                    model: pluginModel,
                    lifecycle: pluginLifecycle
                };
                let frontendInitPath = pluginLifecycle.frontendInitPath;
                if (frontendInitPath) {
                    hostedExtManager.$initialize(frontendInitPath, pluginMetadata);
                } else {
                    frontendInitPath = '';
                }
                // we should create only one instance of the plugin api per connection
                if (!this.frontendApiInitialized) {
                    setUpPluginApi(this.worker.rpc, container);
                    this.frontendApiInitialized = true;
                }
                hostedExtManager.$loadPlugin(frontendInitPath, plugin);
                this.applyPluginContributions(pluginMetadata.source);
            });
        }
        if (pluginModel.entryPoint!.backend) {
            this.logger.info(`Loading backend hosted plugin: ${pluginModel.name}`);
            const rpc = this.createServerRpc();

            this.theiaReadyPromise.then(() => {
                const hostedExtManager = rpc.getProxy(MAIN_RPC_CONTEXT.HOSTED_PLUGIN_MANAGER_EXT);
                const plugin: Plugin = {
                    pluginPath: pluginModel.entryPoint.backend!,
                    model: pluginModel,
                    lifecycle: pluginLifecycle
                };
                let backendInitPath = pluginLifecycle.backendInitPath;
                if (backendInitPath) {
                    hostedExtManager.$initialize(backendInitPath, pluginMetadata);
                } else {
                    backendInitPath = '';
                }
                // we should create only one instance of the plugin api per connection
                if (!this.backendApiInitialized) {
                    setUpPluginApi(rpc, container);
                    this.backendApiInitialized = true;
                }
                hostedExtManager.$loadPlugin(backendInitPath, plugin);
            });
        }
    }

    private applyPluginContributions(pluginPackage: PluginPackage) {
        const contributes = pluginPackage.contributes;

        console.log("All preferences: ", this.prefService.getPreferences());

        if (contributes) {
            Object.keys(contributes).filter(key => {
                const contribution = (contributes as any)[key];
                console.log("key: ", key, "value: ", contribution);
                this.prefService.set(key, contribution, PreferenceScope.Workspace);
            });

            setTimeout(() => {
                this.preferenceContributions.getContributions().forEach(contrib => {
                    for (const property in contrib.schema.properties) {
                        if (this.combinedSchema.properties[property]) {
                            this.logger.error("Preference name collision detected in the schema for property: " + property);
                        } else {
                            this.combinedSchema.properties[property] = contrib.schema.properties[property];
                        }
                    }
                });
                console.log(this.combinedSchema);
                console.log("combined chema is the same :)");
            }, 0);
            // console.log(" pref chema  ", this.prefChemaProvider.getSchema());

            // .forEach(key => {
            //     const contribution = contributes[key];
            //
            // });
        }
    }

    private createServerRpc(): RPCProtocol {
        return new RPCProtocolImpl({
            onMessage: this.watcher.onPostMessageEvent,
            send: message => { this.server.onMessage(JSON.stringify(message)); }
        });
    }
}
