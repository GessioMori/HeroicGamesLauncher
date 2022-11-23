import { GameSettings, SideloadGame } from 'common/types'
import { libraryStore } from './electronStores'
import { GameConfig } from '../game_config'
import { isWindows, isMac, isLinux, heroicGamesConfigPath } from '../constants'
import { killPattern, notify } from '../utils'
import { logInfo, LogPrefix, logWarning } from '../logger/logger'
import { dirname, join } from 'path'
import {
  appendFileSync,
  constants as FS_CONSTANTS,
  existsSync,
  rmSync
} from 'graceful-fs'
import i18next from 'i18next'
import {
  callRunner,
  launchCleanup,
  prepareLaunch,
  runWineCommand,
  setupEnvVars,
  setupWrappers
} from '../launcher'
import { access, chmod } from 'fs/promises'
import { addShortcuts, removeShortcuts } from '../shortcuts/shortcuts/shortcuts'
import shlex from 'shlex'
import { showDialogBoxModalAuto } from '../dialog/dialog'
import { createAbortController } from '../utils/aborthandler/aborthandler'

export function appLogFileLocation(appName: string) {
  return join(heroicGamesConfigPath, `${appName}-lastPlay.log`)
}

export function getAppInfo(appName: string): SideloadGame {
  const store = libraryStore.get('games', [])
  const info = store.find((app) => app.app_name === appName)
  if (!info) {
    // @ts-expect-error TODO: As with LegendaryGame and GOGGame, handle this properly
    return {}
  }
  return info
}

export async function getAppSettings(appName: string): Promise<GameSettings> {
  return (
    GameConfig.get(appName).config ||
    (await GameConfig.get(appName).getSettings())
  )
}

export function addNewApp({
  app_name,
  title,
  install: { executable, platform },
  art_cover,
  art_square
}: SideloadGame): void {
  const game: SideloadGame = {
    runner: 'sideload',
    app_name,
    title,
    install: {
      executable,
      platform
    },
    folder_name: dirname(executable),
    art_cover,
    is_installed: true,
    art_square,
    canRunOffline: true,
    cloud_save_enabled: false
  }

  const current = libraryStore.get('games', [])

  const gameIndex = current.findIndex((value) => value.app_name === app_name)

  // edit app in case it exists
  if (gameIndex !== -1) {
    current[gameIndex] = { ...current[gameIndex], ...game }
  } else {
    current.push(game)
  }

  return libraryStore.set('games', current)
}

export async function addAppShortcuts(
  appName: string,
  fromMenu?: boolean
): Promise<void> {
  return addShortcuts(getAppInfo(appName), fromMenu)
}

export async function removeAppShortcuts(appName: string): Promise<void> {
  return removeShortcuts(getAppInfo(appName))
}

export async function launchApp(appName: string): Promise<boolean> {
  const gameInfo = getAppInfo(appName)
  const {
    install: { executable },
    folder_name
  } = gameInfo

  const gameSettings = await getAppSettings(appName)
  const { launcherArgs } = gameSettings

  if (executable) {
    const {
      success: launchPrepSuccess,
      failureReason: launchPrepFailReason,
      rpcClient,
      mangoHudCommand,
      gameModeBin,
      steamRuntime
    } = await prepareLaunch(gameSettings, gameInfo, isNativeApp(appName))

    const wrappers = setupWrappers(
      gameSettings,
      mangoHudCommand,
      gameModeBin,
      steamRuntime?.length ? [...steamRuntime] : undefined
    )

    if (!launchPrepSuccess) {
      appendFileSync(
        appLogFileLocation(appName),
        `Launch aborted: ${launchPrepFailReason}`
      )
      showDialogBoxModalAuto({
        title: i18next.t('box.error.launchAborted', 'Launch aborted'),
        message: launchPrepFailReason!,
        type: 'ERROR'
      })
      return false
    }
    const env = { ...process.env, ...setupEnvVars(gameSettings) }

    // Native
    if (isNativeApp(appName)) {
      logInfo(
        `launching native sideloaded: ${executable} ${launcherArgs ?? ''}`,
        { prefix: LogPrefix.Backend }
      )

      try {
        await access(executable, FS_CONSTANTS.X_OK)
      } catch (error) {
        logWarning('File not executable, changing permissions temporarilly', {
          prefix: LogPrefix.Backend
        })
        await chmod(executable, 0o775)
      }

      const commandParts = shlex.split(launcherArgs ?? '')
      await callRunner(
        commandParts,
        {
          name: 'sideload',
          logPrefix: LogPrefix.Backend,
          bin: executable,
          dir: dirname(executable)
        },
        createAbortController(appName),
        {
          env,
          wrappers,
          logFile: appLogFileLocation(appName),
          logMessagePrefix: LogPrefix.Backend
        }
      )

      launchCleanup(rpcClient)
      // TODO: check and revert to previous permissions
      await chmod(executable, 0o664)
      return true
    }

    logInfo(`launching non-native sideloaded: ${executable}}`, {
      prefix: LogPrefix.Backend
    })

    await runWineCommand({
      commandParts: [executable, launcherArgs ?? ''],
      gameSettings,
      wait: false,
      startFolder: folder_name,
      options: {
        wrappers,
        logFile: appLogFileLocation(appName),
        logMessagePrefix: LogPrefix.Backend
      }
    })

    launchCleanup(rpcClient)

    return true
  }
  return false
}

export async function stop(appName: string): Promise<void> {
  const {
    install: { executable }
  } = getAppInfo(appName)

  if (executable) {
    const split = executable.split('/')
    const exe = split[split.length - 1]
    killPattern(exe)
  }
}

type RemoveArgs = {
  appName: string
  shouldRemovePrefix: boolean
}
export async function removeApp({
  appName,
  shouldRemovePrefix
}: RemoveArgs): Promise<void> {
  const old = libraryStore.get('games', [])
  const current = old.filter((a: SideloadGame) => a.app_name !== appName)

  const { title } = getAppInfo(appName)
  const { winePrefix } = await getAppSettings(appName)

  if (shouldRemovePrefix) {
    logInfo(`Removing prefix ${winePrefix}`, { prefix: LogPrefix.Backend })
    if (existsSync(winePrefix)) {
      // remove prefix if exists
      rmSync(winePrefix, { recursive: true })
    }
  }
  libraryStore.set('games', current)
  notify({ title, body: i18next.t('notify.uninstalled') })
  logInfo('finished uninstalling', { prefix: LogPrefix.Backend })
}

export function isNativeApp(appName: string): boolean {
  const {
    install: { platform }
  } = getAppInfo(appName)
  if (platform) {
    if (isWindows) {
      return true
    }

    if (isMac && platform === 'Mac') {
      return true
    }

    // small hack, but needs to fix the typings
    const plat = platform.toLowerCase()
    if (isLinux && plat === 'linux') {
      return true
    }
  }

  return false
}
