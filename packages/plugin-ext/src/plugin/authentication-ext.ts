/********************************************************************************
 * Copyright (C) 2020 Red Hat, Inc. and others.
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

import { Disposable } from './types-impl';
import {
    AuthenticationExt,
    AuthenticationMain, Plugin as InternalPlugin,
    PLUGIN_RPC_CONTEXT
} from '../common/plugin-api-rpc';
import { RPCProtocol } from '../common/rpc-protocol';
import { Emitter, Event } from '@theia/core/lib/common/event';
import * as theia from '@theia/plugin';

export class AuthenticationExtImpl implements AuthenticationExt {
    private _proxy: AuthenticationMain;
    private _authenticationProviders: Map<string, theia.AuthenticationProvider> = new Map<string, theia.AuthenticationProvider>();

    private _onDidChangeAuthenticationProviders = new Emitter<theia.AuthenticationProvidersChangeEvent>();
    readonly onDidChangeAuthenticationProviders: Event<theia.AuthenticationProvidersChangeEvent> = this._onDidChangeAuthenticationProviders.event;

    private _onDidChangeSessions = new Emitter<{ [providerId: string]: theia.AuthenticationSessionsChangeEvent }>();
    readonly onDidChangeSessions: Event<{ [providerId: string]: theia.AuthenticationSessionsChangeEvent }> = this._onDidChangeSessions.event;

    constructor(rpc: RPCProtocol) {
        this._proxy = rpc.getProxy(PLUGIN_RPC_CONTEXT.AUTHENTICATION_MAIN);
    }

    getProviderIds(): Promise<ReadonlyArray<string>> {
        return this._proxy.$getProviderIds();
    }

    get providerIds(): string[] {
        const ids: string[] = [];
        this._authenticationProviders.forEach(provider => {
            ids.push(provider.id);
        });

        return ids;
    }

    private async resolveSessions(providerId: string): Promise<ReadonlyArray<theia.AuthenticationSession>> {
        const provider = this._authenticationProviders.get(providerId);

        let sessions;
        if (!provider) {
            sessions = await this._proxy.$getSessions(providerId);
        } else {
            sessions = await provider.getSessions();
        }

        return sessions;
    }

    async hasSessions(providerId: string, scopes: string[]): Promise<boolean> {
        const orderedScopes = scopes.sort().join(' ');
        const sessions = await this.resolveSessions(providerId);
        return !!(sessions.filter(session => session.scopes.sort().join(' ') === orderedScopes).length);
    }

    async getSession(requestingExtension: InternalPlugin, providerId: string, scopes: string[],
                     options: theia.AuthenticationGetSessionOptions & { createIfNone: true }): Promise<theia.AuthenticationSession>;
    async getSession(requestingExtension: InternalPlugin, providerId: string, scopes: string[],
                     options: theia.AuthenticationGetSessionOptions): Promise<theia.AuthenticationSession | undefined> {
        const provider = this._authenticationProviders.get(providerId);
        const extensionName = requestingExtension.model.displayName || requestingExtension.model.name;
        const extensionId = requestingExtension.model.id.toLowerCase();

        if (!provider) {
            return this._proxy.$getSession(providerId, scopes, extensionId, extensionName, options);
        }

        const orderedScopes = scopes.sort().join(' ');
        const sessions = (await provider.getSessions()).filter(s => s.scopes.sort().join(' ') === orderedScopes);

        if (sessions.length) {
            if (!provider.supportsMultipleAccounts) {
                const session = sessions[0];
                const allowed = await this._proxy.$getSessionsPrompt(providerId, session.account.displayName, provider.displayName, extensionId, extensionName);
                if (allowed) {
                    return session;
                } else {
                    throw new Error('User did not consent to login.');
                }
            }

            // On renderer side, confirm consent, ask user to choose between accounts if multiple sessions are valid
            const selected = await this._proxy.$selectSession(providerId, provider.displayName, extensionId, extensionName, sessions, scopes, !!options.clearSessionPreference);
            return sessions.find(session => session.id === selected.id);
        } else {
            if (options.createIfNone) {
                const isAllowed = await this._proxy.$loginPrompt(provider.displayName, extensionName);
                if (!isAllowed) {
                    throw new Error('User did not consent to login.');
                }

                const session = await provider.login(scopes);
                await this._proxy.$setTrustedExtension(providerId, session.account.displayName, extensionId, extensionName);
                return session;
            } else {
                await this._proxy.$requestNewSession(providerId, scopes, extensionId, extensionName);
                return undefined;
            }
        }
    }

    async logout(providerId: string, sessionId: string): Promise<void> {
        const provider = this._authenticationProviders.get(providerId);
        if (!provider) {
            return this._proxy.$logout(providerId, sessionId);
        }

        return provider.logout(sessionId);
    }

    registerAuthenticationProvider(provider: theia.AuthenticationProvider): theia.Disposable {
        if (this._authenticationProviders.get(provider.id)) {
            throw new Error(`An authentication provider with id '${provider.id}' is already registered.`);
        }

        this._authenticationProviders.set(provider.id, provider);

        const listener = provider.onDidChangeSessions(e => {
            this._proxy.$sendDidChangeSessions(provider.id, e);
        });

        this._proxy.$registerAuthenticationProvider(provider.id, provider.displayName, provider.supportsMultipleAccounts);

        return new Disposable(() => {
            listener.dispose();
            this._authenticationProviders.delete(provider.id);
            this._proxy.$unregisterAuthenticationProvider(provider.id);
        });
    }

    $login(providerId: string, scopes: string[]): Promise<theia.AuthenticationSession> {
        const authProvider = this._authenticationProviders.get(providerId);
        if (authProvider) {
            return Promise.resolve(authProvider.login(scopes));
        }

        throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
    }

    $logout(providerId: string, sessionId: string): Promise<void> {
        const authProvider = this._authenticationProviders.get(providerId);
        if (authProvider) {
            return Promise.resolve(authProvider.logout(sessionId));
        }

        throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
    }

    $getSessions(providerId: string): Promise<ReadonlyArray<theia.AuthenticationSession>> {
        const authProvider = this._authenticationProviders.get(providerId);
        if (authProvider) {
            return Promise.resolve(authProvider.getSessions());
        }

        throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
    }

    async $getSessionAccessToken(providerId: string, sessionId: string): Promise<string> {
        const authProvider = this._authenticationProviders.get(providerId);
        if (authProvider) {
            const sessions = await authProvider.getSessions();
            const session = sessions.find(s => s.id === sessionId);
            if (session) {
                return session.accessToken;
            }

            throw new Error(`Unable to find session with id: ${sessionId}`);
        }

        throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
    }

    $onDidChangeAuthenticationSessions(providerId: string, event: theia.AuthenticationSessionsChangeEvent): Promise<void> {
        this._onDidChangeSessions.fire({ [providerId]: event });
        return Promise.resolve();
    }

    $onDidChangeAuthenticationProviders(added: string[], removed: string[]): Promise<void> {
        this._onDidChangeAuthenticationProviders.fire({ added, removed });
        return Promise.resolve();
    }
}
