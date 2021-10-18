import os from 'os'
import usb from 'usb'
import log from 'electron-log'
import { DeviceModel } from '@ledgerhq/devices'
import { getDevices as getLedgerDevices } from '@ledgerhq/hw-transport-node-hid-noevents'

import { UsbSignerAdapter } from '../adapters'
import Ledger from './Ledger'
import store from '../../store'
import { Derivation } from '../Signer/derive'
import { publicEncrypt } from 'crypto'

const IS_WINDOWS = os.type().toLowerCase().includes('windows')

function updateDerivation (ledger: Ledger, derivation = store('main.ledger.derivation'), accountLimit = 0) {
  const liveAccountLimit = accountLimit || (derivation === Derivation.live ? store('main.ledger.liveAccountLimit') : 0)

  ledger.derivation = derivation
  ledger.accountLimit = liveAccountLimit
}

export default class LedgerSignerAdapter extends UsbSignerAdapter {
  private knownSigners: Ledger[];
  private disconnections: { devicePath: string, timeout: NodeJS.Timeout }[]
  private observer: any;

  constructor () {
    super('ledger')

    this.knownSigners = []
    this.disconnections = []
  }

  open () {
    this.observer = store.observer(() => {
      const ledgerDerivation = store('main.ledger.derivation')
      const liveAccountLimit = store('main.ledger.liveAccountLimit')

      Object.values(this.knownSigners).forEach(ledger => {
        if (
          ledger.derivation !== ledgerDerivation || 
          (ledger.derivation === 'live' && ledger.accountLimit !== liveAccountLimit)
        ) {
          updateDerivation(ledger, ledgerDerivation, liveAccountLimit)
          ledger.deriveAddresses()
        }
      })
    })

    super.open()
  }

  close () {
    this.observer.remove()

    super.close()
  }

  reload (signer: Ledger) {
    const ledger = this.knownSigners.find(s => s.devicePath === signer.devicePath)

    if (ledger) {
      ledger.disconnect()
        .then(() => ledger.open())
        .then(() => ledger.connect())
    }
  }

  async handleAttachedDevice (usbDevice: DeviceModel) {
    log.debug(`detected Ledger device attached`, usbDevice)

    const knownPaths = this.knownSigners.map(d => d.devicePath)

    let ledger: Ledger
    let devicePath = this.getAttachedDevicePath(knownPaths)

    console.log({ devicePath })

    if (!devicePath) {
      // if this isn't a new device, check if there is a pending disconnection
      
      // on Windows, the same
      // device will have a different path for the manager and eth apps, so we need to rely on timing
      // to determine if this is the re-connection event for a Ledger that was just disconnected
      const pendingDisconnection = this.disconnections.pop()

      if (!pendingDisconnection) {
        log.error(`could not determine path for attached Ledger device`, usbDevice)
        return
      }

      clearTimeout(pendingDisconnection.timeout)
      devicePath = pendingDisconnection.devicePath
    }

    let existingDeviceIndex = this.knownSigners.findIndex(ledger => ledger.devicePath === devicePath)

    if (existingDeviceIndex >= 0) {
      console.log('EXISTING LEDGER')
      ledger = this.knownSigners[existingDeviceIndex]
    } else {
      console.log('NEW LEDGER')
      ledger = new Ledger(devicePath, usbDevice.id)

      const emitUpdate = () => this.emit('update', ledger)

      ledger.on('update', emitUpdate)
      ledger.on('error', emitUpdate)
      ledger.on('lock', emitUpdate)

      ledger.on('close', () => {
        this.emit('remove', ledger?.id)
      })

      ledger.on('unlock', () => {
        ledger?.connect()
      })

      this.emit('add', ledger)

      this.knownSigners.push(ledger)
    }

    updateDerivation(ledger)

    await ledger.open()
    await ledger.connect()
  }

  handleDetachedDevice (usbDevice: DeviceModel) {
    log.debug(`detected Ledger device detached`, usbDevice)

    const ledger = this.getDetachedSigner(usbDevice)

    console.log({ ledger })

    if (ledger) {
      ledger.disconnect()

      // when a user exits the eth app, it takes a few seconds for the
      // main ledger to reconnect via USB, so attempt to wait for this event
      // instead of immediately removing the signer

      // on Windows, the device reconnects with a completely different mount point
      // path, so we can't reliably check if the one that reconnects is the one that
      // was disconnected
      if (!IS_WINDOWS) {
        this.disconnections.push({
          devicePath: ledger.devicePath,
          timeout: setTimeout(() => {
            const index = this.disconnections.findIndex(d => d.devicePath === ledger.devicePath)
            this.disconnections.splice(index, 1)

            this.knownSigners.splice(this.knownSigners.indexOf(ledger), 1)

            ledger.close()
          }, 5000)
        })
      }
    }
  }

  private getAttachedDevicePath (knownDevicePaths: string[]) {
    // check all Ledger devices and return the device that isn't yet known
    console.log('DEVICES', getLedgerDevices(), { knownDevicePaths })
    const hid = getLedgerDevices().find(d => !knownDevicePaths.includes(d.path || ''))

    return hid?.path || ''
  }

  private getDetachedSigner (usbDevice: DeviceModel) {
    // check all Ledger devices and return the device that is missing from the known devices
    const attachedDevices = getLedgerDevices()

    console.log(this.knownSigners)
    console.log(attachedDevices)

    return this.knownSigners.find(signer => 
      signer.model === usbDevice.id && 
      !attachedDevices.some(device => device.path === signer.devicePath
    ))
  }

  supportsDevice (usbDevice: usb.Device) {
    return usbDevice.deviceDescriptor.idVendor === 0x2c97
  }
}
