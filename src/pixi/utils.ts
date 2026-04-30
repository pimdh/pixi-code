import * as ch from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CancellationError, CancellationToken, Uri, window, workspace } from 'vscode';
import which from 'which';

import { Package, PythonCommandRunConfiguration } from '../api';
import { createDeferred } from '../common/deferred';
import { quoteArgs } from '../common/execUtils';
import { findPythonExecutable } from '../common/findPython';
import { traceError, traceInfo, traceVerbose } from '../common/logging';
import { getWorkspacePersistentState } from '../common/persistentState';
import { EXTENSION_ID, untildify } from '../common/utils';
import { PixiEnvironment, PixiInfo, PixiPackage } from './types';

export const PIXI_WORKSPACE_KEY = `${EXTENSION_ID}:pixi:WORKSPACE_SELECTED`;
export const PIXI_GLOBAL_KEY = `${EXTENSION_ID}:pixi:GLOBAL_SELECTED`;
export const DEFAULT_SEARCH_PATH_MAX_DEPTH = 2;
const DEFAULT_IGNORED_DIRECTORY_NAMES = new Set(['.git', '.hg', '.svn', '.pixi', 'node_modules']);

export async function findPixi(): Promise<string | undefined> {
    try {
        return await which('pixi');
    } catch {
        return undefined;
    }
}

export async function getPixi(): Promise<string> {
    const config = workspace.getConfiguration('pixi');
    const value = config.get<string>('executablePath');

    if (!value || typeof value !== 'string') {
        const pixiPath = await findPixi();
        if (!pixiPath) {
            const errorMsg =
                'Pixi executable not found. Please install Pixi or set "pixi-code.pixiExecutable" in your settings.';
            window.showErrorMessage(errorMsg);
            throw new Error(errorMsg);
        }
        return pixiPath;
    }
    return untildify(value);
}

async function _runPixi(
    pixi: string,
    args: string[],
    options?: ch.SpawnOptions,
    token?: CancellationToken,
): Promise<string> {
    const deferred = createDeferred<string>();
    args = quoteArgs(args);
    const proc = ch.spawn(pixi, args, {
        shell: true,
        ...options,
    });

    token?.onCancellationRequested(() => {
        proc.kill();
        deferred.reject(new CancellationError());
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => {
        const d = data.toString('utf-8');
        stdout += d;
    });
    proc.stderr?.on('data', (data) => {
        const d = data.toString('utf-8');
        stderr += d;
        traceError(d.trim());
    });
    proc.on('close', () => {
        deferred.resolve(stdout);
    });
    proc.on('exit', (code) => {
        if (code !== 0) {
            deferred.reject(new Error(`Failed to run "pixi ${args.join(' ')}":\n ${stderr}`));
        }
    });

    return deferred.promise;
}

export async function runPixi(args: string[], options?: ch.SpawnOptions, token?: CancellationToken): Promise<string> {
    const pixi = await getPixi();
    return await _runPixi(pixi, args, options, token);
}

function createShellActivationCommands(
    pixi: string,
    manifestPath: string,
    envName: string,
    additionalFlags: string[],
): Map<string, PythonCommandRunConfiguration[]> {
    const shellActivation = new Map<string, PythonCommandRunConfiguration[]>();
    const additionalFlagsStr = additionalFlags.join(' ');
    const shellHookCmd = `${pixi} shell-hook --manifest-path ${manifestPath} -e ${envName} ${additionalFlagsStr}`;

    // POSIX-like shells (bash, zsh, sh, ksh)
    const posixShells = ['bash', 'zsh', 'sh', 'ksh', 'gitbash', 'wsl', 'unknown'];
    for (const shell of posixShells) {
        shellActivation.set(shell, [{ executable: 'eval', args: [`"$(${shellHookCmd})"`] }]);
    }

    // Fish shell
    shellActivation.set('fish', [{ executable: 'eval', args: [`(${shellHookCmd})`] }]);

    // PowerShell
    shellActivation.set('pwsh', [{ executable: 'Invoke-Expression', args: [`(& ${shellHookCmd})`] }]);

    // Windows CMD - call pixi shell-hook directly and execute the output
    shellActivation.set('cmd', [{ executable: shellHookCmd }]);

    return shellActivation;
}

export function isPixiProjectDir(projectPath: string): boolean {
    if (!fs.existsSync(projectPath)) {
        return false;
    }

    const pixiTomlPath = path.join(projectPath, 'pixi.toml');
    if (fs.existsSync(pixiTomlPath)) {
        return true;
    }

    const pyprojectPath = path.join(projectPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
        try {
            const content = fs.readFileSync(pyprojectPath, 'utf-8');
            return /^\[tool\.pixi(\.|])/m.test(content);
        } catch (error) {
            traceVerbose(`Error reading pyproject.toml at ${pyprojectPath}: ${error}`);
        }
    }

    return false;
}

/**
 * Discover Pixi projects under the provided root directory up to the specified depth.
 */
async function discoverPixiProjectsUnderPath(
    rootPath: string,
    maxDepth: number,
    ignoredDirectories: Set<string>,
): Promise<string[]> {
    const results: string[] = [];

    let stat;
    try {
        stat = await fs.promises.stat(rootPath);
        if (!stat.isDirectory()) {
            traceVerbose(`Search path is not a directory: ${rootPath}`);
            return results;
        }
    } catch (error) {
        traceVerbose(`Error accessing search path ${rootPath}: ${error}`);
        return results;
    }

    type QueueItem = { path: string; depth: number };
    const queue: QueueItem[] = [{ path: rootPath, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const { path: currentPath, depth } = queue.shift()!;
        if (visited.has(currentPath)) {
            continue;
        }
        visited.add(currentPath);

        if (isPixiProjectDir(currentPath)) {
            results.push(currentPath);
        }

        if (depth >= maxDepth) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            traceVerbose(`Error reading directory ${currentPath}: ${error}`);
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                continue;
            }

            if (ignoredDirectories.has(entry.name)) {
                continue;
            }

            const nextPath = path.join(currentPath, entry.name);
            queue.push({ path: nextPath, depth: depth + 1 });
        }
    }

    traceVerbose(`Discovered ${results.length} Pixi projects under ${rootPath} (max depth ${maxDepth})`);
    return results;
}

/**
 * Discover Pixi projects from the provided collection of root search paths.
 * The result is deduplicated and only includes directories containing a Pixi manifest.
 */
export async function discoverPixiProjects(
    rootPaths: Iterable<string>,
    maxDepth: number = DEFAULT_SEARCH_PATH_MAX_DEPTH,
): Promise<string[]> {
    const discoveredProjects = new Set<string>();
    for (const rootPath of rootPaths) {
        const projects = await discoverPixiProjectsUnderPath(rootPath, maxDepth, DEFAULT_IGNORED_DIRECTORY_NAMES);
        for (const project of projects) {
            discoveredProjects.add(project);
        }
    }

    return Array.from(discoveredProjects);
}

export async function refreshPixi(project_path: string): Promise<PixiEnvironment[]> {
    try {
        if (!fs.existsSync(project_path)) {
            traceVerbose(`Project path does not exist: ${project_path}`);
            return [];
        }

        if (!isPixiProjectDir(project_path)) {
            return [];
        }

        const pixi = await getPixi();
        const environments: PixiEnvironment[] = [];

        const stdout = await runPixi(['info', '--json'], { cwd: project_path });
        const pixiInfo: PixiInfo = JSON.parse(stdout);

        if (!pixiInfo.project_info) {
            traceVerbose(`No project info found for Pixi project at ${project_path}`);
            return [];
        }

        const projectName = pixiInfo.project_info.name;
        const manifestPath = pixiInfo.project_info.manifest_path;

        // Read configuration options for --no-install and --frozen flags
        const config = workspace.getConfiguration('pixi-code');
        const noInstall = config.get<boolean>('noInstall', false);
        const frozen = config.get<boolean>('frozen', false);

        // Build additional flags for run and shell commands
        const additionalFlags: string[] = [];
        if (noInstall) {
            additionalFlags.push('--no-install');
        }
        if (frozen) {
            additionalFlags.push('--frozen');
        }

        for (const pixiEnv of pixiInfo.environments_info) {
            if (pixiEnv.platforms && !pixiEnv.platforms.includes(pixiInfo.platform)) {
                traceVerbose(
                    `Skipping environment '${pixiEnv.name}' in ${project_path}: ` +
                        `target platforms [${pixiEnv.platforms.join(', ')}] do not include host '${pixiInfo.platform}'`,
                );
                continue;
            }

            let pixiPackages: PixiPackage[];
            try {
                const stdout = await runPixi(
                    ['list', '--no-install', '--frozen', '--json', '--environment', pixiEnv.name],
                    {
                        cwd: project_path,
                    },
                );
                pixiPackages = JSON.parse(stdout);
            } catch (error) {
                traceInfo(`Skipping environment '${pixiEnv.name}' in ${project_path}: ${error}`);
                continue;
            }
            const pythonPackage = pixiPackages.find((pkg) => pkg.name === 'python');

            // Skip environments without Python
            if (!pythonPackage) {
                continue;
            }

            // If the environment is not installed, do not skip it.
            // Both `pixi info` and `pixi list` work fine with an environment that is not installed, and we want to take
            // advantage of that. Besides, `pythonExecutable` isn't really used, since we provide both `activatedRun`
            // and shell activation commands.
            const pythonExecutable = (await findPythonExecutable(pixiEnv.prefix)) || '';

            const shellActivation = createShellActivationCommands(
                pixi,
                manifestPath,
                pixiEnv.name,
                additionalFlags,
            );

            const env: PixiEnvironment = {
                name: pixiEnv.name,
                displayName: pixiEnv.name,
                shortDisplayName: pixiEnv.name,
                displayPath: pixiEnv.prefix,
                version: pythonPackage.version,
                environmentPath: Uri.file(pixiEnv.prefix),
                description: `Python ${pythonPackage.version}`,
                execInfo: {
                    run: { executable: pythonExecutable },
                    activatedRun: {
                        executable: pythonExecutable,
                        args: [],
                    },
                    shellActivation,
                    deactivation: [
                        {
                            executable: 'exit',
                            args: [],
                        },
                    ],
                },
                sysPrefix: pixiEnv.prefix,
                group: projectName,
                envId: {
                    id: pixiEnv.prefix,
                    managerId: `${EXTENSION_ID}:pixi`,
                },
                pixiInfo,
                packages: pixiPkgsToPackages(pixiPackages, pixiEnv.prefix),
            };

            environments.push(env);
        }

        return environments;
    } catch (error) {
        traceInfo(`Failed to get pixi environments: ${error}`);
        return [];
    }
}

export function pixiPkgsToPackages(pixiPackages: PixiPackage[], environmentId: string): Package[] {
    return pixiPackages
        .filter((pkg) => pkg.is_explicit)
        .map((pkg) => ({
            name: pkg.name,
            displayName: pkg.name,
            description: pkg.version,
            version: pkg.version,
            pkgId: {
                id: pkg.name,
                managerId: `${EXTENSION_ID}:pixi`,
                environmentId,
            },
        }));
}

export type PixiPersistentState = {
    [projectPath: string]: string; // Maps project paths to Pixi prefixes
};

export async function clearExtensionCache() {
    const keys = [PIXI_WORKSPACE_KEY, PIXI_GLOBAL_KEY];
    const state = await getWorkspacePersistentState();
    await state.clear(keys);
}

export async function getGlobalEnvId(): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    return state.get(PIXI_GLOBAL_KEY);
}

export async function setGlobalEnvId(envId: string | undefined) {
    const state = await getWorkspacePersistentState();
    await state.set(PIXI_GLOBAL_KEY, envId);
}

export async function getProjectEnvId(projectPath: string): Promise<string | undefined> {
    const state = await getWorkspacePersistentState();
    const data: PixiPersistentState = (await state.get(PIXI_WORKSPACE_KEY)) ?? {};
    return data[projectPath];
}

export async function setProjectEnvId(projectPath: string, envId: string | undefined) {
    const state = await getWorkspacePersistentState();
    const data: PixiPersistentState = (await state.get(PIXI_WORKSPACE_KEY)) ?? {};
    if (envId) {
        data[projectPath] = envId;
    } else {
        delete data[projectPath];
    }
    await state.set(PIXI_WORKSPACE_KEY, data);
}
