import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "odysseas.resources"
  ipcTarget: "odysseas.resources"
  property var previous: []
  property var usage: []
  property var memory: ({})
  property var loads: []
  property real uptime: 0
  property bool ready: false
  readonly property real cpu: usage.length ? usage[0] : 0
  readonly property real ram: memory.MemTotal ? 100 * (1 - memory.MemAvailable / memory.MemTotal) : 0
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function gib(kib) { return ((kib || 0) / 1048576).toFixed(1) + " GiB" }
  function refresh() { if (!sample.running) sample.running = true }
  function update(raw) {
    try {
      var data = JSON.parse(raw)
      var next = []
      for (var i = 0; i < data.cpus.length; i++) {
        var old = previous[i]
        var current = data.cpus[i]
        var delta = old ? current.total - old.total : 0
        next.push(delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - old.idle) / delta))) : 0)
      }
      ready = previous.length > 0
      previous = data.cpus
      usage = next
      memory = data.memory
      loads = data.load
      uptime = data.uptime
    } catch (error) { console.warn("Resource sample:", error) }
  }

  Process {
    id: sample
    command: ["python3", Qt.resolvedUrl("sample.py").toString().replace(/^file:\/\//, "")]
    stdout: StdioCollector { onStreamFinished: root.update(text) }
  }
  Timer { interval: 2000; running: true; repeat: true; triggeredOnStart: true; onTriggered: root.refresh() }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    fontSize: Style.font.body
    fixedWidth: vertical ? -1 : Style.space(160)
    text: vertical ? "󰍛" : "CPU " + (root.ready ? Math.round(root.cpu) + "%" : "—") + "  RAM " + (root.memory.MemTotal ? Math.round(root.ram) + "%" : "—")
    tooltipText: "CPU · Memory"
    onPressed: function(b) { if (b === Qt.LeftButton) root.toggle() }
  }

  KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keys
    contentWidth: popup.fittedContentWidth(Style.space(340))
    contentHeight: popup.fittedContentHeight(content.implicitHeight)
    PanelKeyCatcher {
      id: keys
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      Column {
        id: content
        width: parent.width
        spacing: Style.space(14)
        Text {
          text: "System resources"
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.title
          font.bold: true
        }
        Meter { label: "CPU"; detail: root.ready ? Math.round(root.cpu) + "%" : "Sampling…"; value: root.cpu }
        Flow {
          width: parent.width
          spacing: Style.space(6)
          Repeater {
            model: root.usage.slice(1)
            Rectangle {
              required property int index
              required property var modelData
              width: Style.space(68)
              height: Style.space(25)
              radius: Style.space(4)
              color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.07)
              Text {
                anchors.centerIn: parent
                text: (index + 1) + ": " + Math.round(modelData) + "%"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }
        }
        Text {
          text: "Load  " + root.loads.join(" · ") + "  (1 / 5 / 15 min)"
          color: root.foreground
          opacity: 0.65
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
        PanelSeparator { foreground: root.foreground }
        Meter {
          label: "Memory"
          detail: root.gib(root.memory.MemTotal - root.memory.MemAvailable) + " / " + root.gib(root.memory.MemTotal)
          value: root.ram
        }
        Text {
          text: "Available  " + root.gib(root.memory.MemAvailable) + "\nSwap  " + root.gib(root.memory.SwapTotal - root.memory.SwapFree) + " / " + root.gib(root.memory.SwapTotal)
          color: root.foreground
          opacity: 0.65
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          lineHeight: 1.4
        }
        PanelSeparator { foreground: root.foreground }
        Text {
          text: "Uptime  " + Math.floor(root.uptime / 86400) + "d " + Math.floor(root.uptime / 3600 % 24) + "h " + Math.floor(root.uptime / 60 % 60) + "m"
          color: root.foreground
          opacity: 0.65
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  component Meter: Column {
    property string label: ""
    property string detail: ""
    property real value: 0
    width: parent.width
    spacing: Style.space(8)
    Item {
      width: parent.width
      height: Style.space(22)
      Text { text: label; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.body; font.bold: true }
      Text { anchors.right: parent.right; text: detail; color: root.foreground; font.family: root.fontFamily; font.pixelSize: Style.font.bodySmall }
    }
    Rectangle {
      width: parent.width
      height: Style.space(4)
      radius: height / 2
      color: Qt.rgba(root.foreground.r, root.foreground.g, root.foreground.b, 0.12)
      Rectangle {
        width: parent.width * Math.max(0, Math.min(100, value)) / 100
        height: parent.height
        radius: parent.radius
        color: Color.accent
        Behavior on width { NumberAnimation { duration: 250 } }
      }
    }
  }
}
