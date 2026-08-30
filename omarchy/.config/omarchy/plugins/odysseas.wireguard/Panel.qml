import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "odysseas.wireguard"
  ipcTarget: "odysseas.wireguard"
  manageIpc: false

  property bool active: false
  property bool busy: false
  property string address: ""
  property string endpoint: "vpn.luca.health:51820"
  property string lastError: ""
  property int selectedAction: 0
  property bool cursorActive: false
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function refresh() {
    if (!statusProcess.running) statusProcess.running = true
  }

  function setActive(wanted) {
    if (busy) return
    busy = true
    lastError = ""
    actionProcess.command = ["nmcli", "connection", wanted ? "up" : "down", "odysseas-laptop"]
    actionProcess.running = true
  }

  function toggleConnection() { setActive(!active) }
  function quitConnection() {
    setActive(false)
    close()
  }

  // Keep the bar clean while the VPN is disconnected. It remains available
  // from the Omarchy menu and reappears automatically when connected.
  visible: active
  implicitWidth: active ? button.implicitWidth : 0
  implicitHeight: active ? button.implicitHeight : 0

  Component.onCompleted: refresh()
  onOpenedChanged: if (opened) {
    selectedAction = 0
    cursorActive = false
    refresh()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(); return "ok" }
    function up(): string { root.setActive(true); return "ok" }
    function down(): string { root.setActive(false); return "ok" }
    function toggleWireguard(): string { root.toggleConnection(); return "ok" }
    function status(): string { return root.active ? "connected" : "disconnected" }
  }

  Process {
    id: statusProcess
    command: ["sh", "-c", "state=$(nmcli -g GENERAL.STATE connection show odysseas-laptop 2>/dev/null || true); addr=$(nmcli -g IP4.ADDRESS device show odysseas-laptop 2>/dev/null | head -n1); printf '%s\\n%s\\n' \"$state\" \"$addr\""]
    stdout: StdioCollector { id: statusOutput; waitForEnd: true }
    onExited: function(exitCode) {
      var lines = String(statusOutput.text || "").trim().split("\n")
      root.active = lines.length > 0 && lines[0] === "activated"
      root.address = lines.length > 1 ? lines[1] : ""
    }
  }

  Process {
    id: actionProcess
    stderr: StdioCollector { id: actionError; waitForEnd: true }
    onExited: function(exitCode) {
      root.busy = false
      if (exitCode !== 0) root.lastError = String(actionError.text || "WireGuard action failed").trim()
      root.refresh()
    }
  }

  Timer {
    interval: 5000
    repeat: true
    running: true
    onTriggered: root.refresh()
  }

  BarIconButton {
    id: button
    visible: root.active
    anchors.fill: parent
    bar: root.bar
    text: "󰖂"
    dimmed: !root.active
    tooltipText: "WireGuard · " + (root.active ? "Connected" : "Disconnected")
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) root.toggleConnection()
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        var delta = dx !== 0 ? dx : dy
        root.selectedAction = Math.max(0, Math.min(2, root.selectedAction + (delta > 0 ? 1 : -1)))
      }
      onActivateRequested: {
        if (!root.cursorActive) { root.cursorActive = true; return }
        if (root.selectedAction === 2) root.quitConnection()
        else root.toggleConnection()
      }
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "q" || t === "Q") root.quitConnection()
        else if (t === "t" || t === "T") root.toggleConnection()
      }

      Column {
        id: content
      width: parent.width
      spacing: Style.space(14)

      PanelHero {
        width: parent.width
        title: "WireGuard"
        meta: root.active ? "CONNECTED" : "DISCONNECTED"
        foreground: root.foreground
        fontFamily: root.fontFamily
        iconOpacity: root.active ? 1.0 : 0.45
        iconComponent: Component {
          Text {
            text: "󰖂"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
          }
        }
        trailingControl: Component {
          ToggleSwitch {
            checked: root.active
            busy: root.busy
            hasCursor: root.cursorActive && root.selectedAction === 0
            foreground: root.foreground
            onToggled: root.toggleConnection()
          }
        }
      }

      Text {
        width: parent.width
        text: root.active
          ? ((root.address !== "" ? root.address + " · " : "") + root.endpoint)
          : "Connection: odysseas-laptop"
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
      }

      Text {
        visible: root.lastError !== ""
        width: parent.width
        text: root.lastError
        color: root.bar ? root.bar.urgent : Color.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        wrapMode: Text.WordWrap
      }

      RowLayout {
        width: parent.width
        spacing: Style.space(10)

        Button {
          Layout.fillWidth: true
          text: root.active ? "Disconnect" : "Connect"
          iconText: root.active ? "󰅖" : "󰐕"
          foreground: root.foreground
          fontFamily: root.fontFamily
          bordered: true
          hasCursor: root.cursorActive && root.selectedAction === 1
          enabled: !root.busy
          onClicked: root.toggleConnection()
        }

        Button {
          text: "Quit"
          iconText: "󰗼"
          foreground: root.foreground
          fontFamily: root.fontFamily
          bordered: true
          hasCursor: root.cursorActive && root.selectedAction === 2
          enabled: root.active && !root.busy
          onClicked: root.quitConnection()
        }
      }
      }
    }
  }
}
