const attachments = require("./data/attachments");
const logs = require("./data/logs");
const { beforeNewThread } = require("./hooks/beforeNewThread");
const { beforeNewMessageReceived } = require("./hooks/beforeNewMessageReceived");
const { afterNewMessageReceived } = require("./hooks/afterNewMessageReceived");
const { afterThreadClose } = require("./hooks/afterThreadClose");
const { afterThreadCloseScheduled } = require("./hooks/afterThreadCloseScheduled");
const { afterThreadCloseScheduleCanceled } = require("./hooks/afterThreadCloseScheduleCanceled");
const formats = require("./formatters");
const webserver = require("./modules/webserver");
const childProcess = require("child_process");
const fs = require("fs");
const pacote = require("pacote");
const path = require("path");
const threads = require("./data/threads");
const displayRoles = require("./data/displayRoles");
const { PluginInstallationError } = require("./PluginInstallationError");
const config = require("./cfg");

const PLUGIN_INSTALL_MAX_RETRIES = Number(process.env.MM_PLUGIN_INSTALL_MAX_RETRIES || 5);
const PLUGIN_INSTALL_RETRY_BASE_DELAY_MS = Number(process.env.MM_PLUGIN_INSTALL_RETRY_BASE_DELAY_MS || 10000);
const PLUGIN_INSTALL_RETRY_MAX_DELAY_MS = Number(process.env.MM_PLUGIN_INSTALL_RETRY_MAX_DELAY_MS || 120000);

const npmGitHubPattern = /^([a-z0-9_.-]+)\/([a-z0-9_.-]+)(?:#([a-z0-9_.-]+))?$/i;

function githubTarballUrl(pluginName) {
  const parts = pluginName.match(npmGitHubPattern);
  if (! parts) return null;
  return `https://api.github.com/repos/${parts[1]}/${parts[2]}/tarball${parts[3] ? "/" + parts[3] : ""}`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryablePluginInstallError(err) {
  const combined = `${err && err.message ? err.message : ""}\n${err && err.stderr ? err.stderr : ""}`;
  return /(?:^|\D)403(?:\D|$)|\bE403\b/i.test(combined);
}

function runNpmInstall(npmProcessName, pluginsToInstall) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const npmProcess = childProcess.spawn(
      npmProcessName,
      ["install", "--verbose", "--no-save", ...pluginsToInstall],
      { cwd: process.cwd(), shell: true }
    );

    npmProcess.stderr.on("data", data => { stderr += String(data) });
    npmProcess.on("close", code => {
      if (code !== 0) {
        const err = new PluginInstallationError(stderr);
        err.stderr = stderr;
        err.code = code;
        return reject(err);
      }
      return resolve();
    });
  });
}

const pluginNameCacheFile = path.join(config.dbDir, "plugin-names.json");

function loadPluginNameCache() {
  try {
    return JSON.parse(fs.readFileSync(pluginNameCacheFile, "utf8"));
  } catch {
    return {};
  }
}

function savePluginNameCache(cache) {
  try {
    fs.writeFileSync(pluginNameCacheFile + ".tmp", JSON.stringify(cache, null, 2));
    fs.renameSync(pluginNameCacheFile + ".tmp", pluginNameCacheFile);
  } catch (err) {
    console.warn(`[WARN] Failed to write plugin name cache (${pluginNameCacheFile}): ${err.message}`);
  }
}

// Bare package name for plain/scoped npm specs ("pkg@1.2.3" -> "pkg",
// "@org/pkg@1.2.3" -> "@org/pkg", "pkg" -> "pkg"). GitHub specs return null.
function npmSpecPackageName(spec) {
  if (! npmGitHubPattern.test(spec)) {
    if (spec.startsWith("@")) {
      const lastAt = spec.lastIndexOf("@");
      return lastAt > 0 ? spec.slice(0, lastAt) : spec;
    }
    const at = spec.indexOf("@");
    return at !== -1 ? spec.slice(0, at) : spec;
  }
  return null;
}

// After installing GitHub specs as tarball URLs, recover each spec's package
// name from the lockfile npm maintains inside node_modules. No network.
// Matches the recorded "resolved" URL exactly first, then falls back to a
// repo-level prefix match so the lookup still works if npm normalizes the
// URL differently (e.g. appends the resolved commit to unpinned refs).
function resolveNamesFromLockfile(specs) {
  const urlToSpec = new Map();
  const repoPrefixToSpec = new Map();
  for (const spec of specs) {
    const url = githubTarballUrl(spec);
    if (! url) continue;
    urlToSpec.set(url, spec);
    repoPrefixToSpec.set(url.slice(0, url.lastIndexOf("/tarball")), spec);
  }
  if (urlToSpec.size === 0) return {};

  let lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(path.join(process.cwd(), "node_modules", ".package-lock.json"), "utf8"));
  } catch {
    return {};
  }

  const resolved = {};
  for (const [pkgPath, info] of Object.entries(lockfile.packages || {})) {
    if (! info.resolved) continue;
    const packageName = pkgPath.replace(/^node_modules\//, "");
    const exactSpec = urlToSpec.get(info.resolved);
    if (exactSpec) {
      resolved[exactSpec] = packageName;
      continue;
    }
    for (const [repoPrefix, spec] of repoPrefixToSpec) {
      if (info.resolved.startsWith(repoPrefix + "/tarball") && ! resolved[spec]) {
        resolved[spec] = packageName;
      }
    }
  }
  return resolved;
}

function updatePluginNameCache(specs) {
  const cache = loadPluginNameCache();
  const fromLockfile = resolveNamesFromLockfile(specs);
  for (const spec of specs) {
    if (fromLockfile[spec]) {
      cache[spec] = fromLockfile[spec];
    } else {
      const name = npmSpecPackageName(spec);
      if (name) cache[spec] = name;
    }
  }
  savePluginNameCache(cache);
}

const pluginSources = {
  npm: {
    install(plugins) {
      return new Promise(async (resolve, reject) => {
        try {
          console.log(`Checking ${plugins.length} npm plugin(s)...`);

          const nameCache = loadPluginNameCache();
          const missingPlugins = [];

          if (config.reinstallPlugins) {
            console.log("reinstallPlugins is set, skipping installation cache...");
            missingPlugins.push(...plugins);
          } else {
            for (const pluginName of plugins) {
              const cachedName = nameCache[pluginName];
              if (cachedName) {
                try {
                  require.resolve(cachedName);
                  console.log(`Plugin '${pluginName}' already installed, skipping.`);
                  continue;
                } catch (e) {}
              }
              console.log(`Plugin '${pluginName}' not installed, queuing for install.`);
              const gitHubParts = pluginName.match(npmGitHubPattern);
              if (gitHubParts && ! gitHubParts[3]) {
                console.warn(`[WARN] GitHub plugin '${pluginName}' is not pinned to a commit — add #<sha> to the spec to avoid fetching unknown code on future installs.`);
              }
              missingPlugins.push(pluginName);
            }
          }

          if (missingPlugins.length === 0) {
            console.log("All npm plugins already installed.");
            return resolve();
          }

          console.log(`Installing ${missingPlugins.length} npm plugin(s)...`);

          if (! process.env.GITHUB_TOKEN && missingPlugins.some(p => githubTarballUrl(p))) {
            console.warn("[WARN] GITHUB_TOKEN is not set — GitHub tarball plugin installs will be unauthenticated (60 req/hr rate limit).");
          }

          let finalPluginNames = missingPlugins;
          if (! config.useGitForGitHubPlugins) {
            finalPluginNames = missingPlugins.map(pluginName => githubTarballUrl(pluginName) || pluginName);
          }

          const npmProcessName = /^win/.test(process.platform) ? "npm.cmd" : "npm";
          const totalAttempts = Math.max(1, PLUGIN_INSTALL_MAX_RETRIES + 1);

          for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            try {
              if (attempt > 1) {
                console.log(`Retrying npm plugin install (attempt ${attempt}/${totalAttempts})...`);
              }

              await runNpmInstall(npmProcessName, finalPluginNames);
              updatePluginNameCache(missingPlugins);
              return resolve();
            } catch (err) {
              const shouldRetry = isRetryablePluginInstallError(err) && attempt < totalAttempts;
              if (! shouldRetry) {
                return reject(err);
              }

              const delay = Math.min(
                PLUGIN_INSTALL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
                PLUGIN_INSTALL_RETRY_MAX_DELAY_MS
              );
              console.log(`Plugin install hit HTTP 403/rate limit. Retrying in ${Math.round(delay / 1000)}s...`);
              await wait(delay);
            }
          }
        } catch (err) {
          return reject(err);
        }
      });
    },

    async load(plugin, pluginApi) {
      // Prefer the persistent name cache so loading never needs a network
      // round-trip (pacote.manifest fetches from api.github.com / the npm
      // registry on every call).
      let packageName = loadPluginNameCache()[plugin];
      if (! packageName) {
        if (plugin.startsWith("@")) {
          // Scoped package names (e.g. @org/pkg) are already installed by
          // install() — skip pacote.manifest() which ignores .npmrc scoped
          // registries and resolves against registry.npmjs.org instead.
          packageName = plugin;
        } else if (npmGitHubPattern.test(plugin)) {
          packageName = resolveNamesFromLockfile([plugin])[plugin];
          if (! packageName) {
            throw new PluginInstallationError(`Plugin '${plugin}' could not be resolved from the local install (see FORK_CHANGES.md restart-loop runbook, step 3)`);
          }
          const cache = loadPluginNameCache();
          cache[plugin] = packageName;
          savePluginNameCache(cache);
        } else {
          packageName = (await pacote.manifest(plugin)).name;
          const cache = loadPluginNameCache();
          cache[plugin] = packageName;
          savePluginNameCache(cache);
        }
      }
      const pluginFn = require(packageName);
      if (typeof pluginFn !== "function") {
        throw new PluginInstallationError(`Plugin '${plugin}' is not a valid plugin`);
      }

      return pluginFn(pluginApi);
    },
  },

  file: {
    install(plugins) {},
    load(plugin, pluginApi) {
      const requirePath = path.join(__dirname, "..", plugin);
      const pluginFn = require(requirePath);
      if (typeof pluginFn !== "function") {
        throw new PluginInstallationError(`Plugin '${plugin}' is not a valid plugin`);
      }
      return pluginFn(pluginApi);
    },
  }
};

const defaultPluginSource = "file";

function splitPluginSource(pluginName) {
  for (const pluginSource of Object.keys(pluginSources)) {
    if (pluginName.startsWith(`${pluginSource}:`)) {
      return {
        source: pluginSource,
        plugin: pluginName.slice(pluginSource.length + 1),
      };
    }
  }

  return {
    source: defaultPluginSource,
    plugin: pluginName,
  };
}

module.exports = {
  async installPlugins(plugins) {
    const pluginsBySource = {};

    for (const pluginName of plugins) {
      const { source, plugin } = splitPluginSource(pluginName);
      pluginsBySource[source] = pluginsBySource[source] || [];
      pluginsBySource[source].push(plugin);
    }

    for (const [source, sourcePlugins] of Object.entries(pluginsBySource)) {
      await pluginSources[source].install(sourcePlugins);
    }
  },

  async loadPlugins(plugins, pluginApi) {
    for (const pluginName of plugins) {
      const { source, plugin } = splitPluginSource(pluginName);
      await pluginSources[source].load(plugin, pluginApi);
    }
  },

  /**
   * @returns {PluginAPI}
   */
  getPluginAPI({ bot, knex, commands }) {
    return {
      bot,
      knex,
      config,
      commands: {
        manager: commands.manager,
        addGlobalCommand: commands.addGlobalCommand,
        addInboxServerCommand: commands.addInboxServerCommand,
        addInboxThreadCommand: commands.addInboxThreadCommand,
        addAlias: commands.addAlias
      },
      attachments: {
        addStorageType: attachments.addStorageType,
        downloadAttachment: attachments.downloadAttachment,
        saveAttachment: attachments.saveAttachment,
      },
      logs: {
        addStorageType: logs.addStorageType,
        saveLogToStorage: logs.saveLogToStorage,
        getLogUrl: logs.getLogUrl,
        getLogFile: logs.getLogFile,
        getLogCustomResponse: logs.getLogCustomResponse,
      },
      hooks: {
        beforeNewThread,
        beforeNewMessageReceived,
        afterNewMessageReceived,
        afterThreadClose,
        afterThreadCloseScheduled,
        afterThreadCloseScheduleCanceled,
      },
      formats,
      webserver,
      threads,
      displayRoles,
    };
  },
};
