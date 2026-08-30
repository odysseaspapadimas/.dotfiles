import QtQuick
import QtQuick.Layouts
import Quickshell.Hyprland
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "omarchy.workspaces"

  function workspaceById(id) {
    var values = Hyprland.workspaces.values
    for (var i = 0; i < values.length; i++) {
      if (values[i].id === id) return values[i]
    }

    return null
  }

  function workspaceIds() {
    var ids = [1, 2, 3, 4, 5]
    var values = Hyprland.workspaces.values

    for (var i = 0; i < values.length; i++) {
      var id = values[i].id
      if (id > 0 && id <= 10 && ids.indexOf(id) === -1) ids.push(id)
    }

    ids.sort(function(left, right) { return left - right })
    return ids
  }

  function focusWorkspace(id) {
    if (!root.bar) return
    root.bar.run("hyprctl dispatch " + Util.shellQuote("hl.dsp.focus({ workspace = \"" + id + "\" })"))
  }

  readonly property real trailingGap: root.vertical ? 0 : Style.spaceReal(1.5)

  implicitWidth: grid.implicitWidth + trailingGap
  implicitHeight: grid.implicitHeight

  GridLayout {
    id: grid
    anchors.fill: parent
    anchors.rightMargin: root.trailingGap
    columns: root.vertical ? 1 : root.workspaceIds().length
    columnSpacing: root.vertical ? 0 : Style.space(1)
    rowSpacing: root.vertical ? Style.space(2) : 0

    Repeater {
      model: root.workspaceIds()

      Item {
        required property int modelData

        readonly property var workspace: root.workspaceById(modelData)
        readonly property bool occupied: workspace !== null && workspace.toplevels.values.length > 0
        readonly property bool focused: Hyprland.focusedWorkspace !== null && Hyprland.focusedWorkspace.id === modelData

        implicitWidth: button.implicitWidth
        implicitHeight: button.implicitHeight

        Rectangle {
          anchors.fill: parent
          anchors.margins: Style.spaceReal(1)
          radius: Math.max(0, Style.cornerRadius)
          color: parent.focused ? Util.alpha(Color.accent, 0.10) : "transparent"

          Behavior on color { ColorAnimation { duration: 160 } }
        }

        Rectangle {
          visible: parent.focused
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.bottom: parent.bottom
          width: parent.width - Style.spaceReal(4)
          height: Style.spaceReal(1)
          color: Color.accent
        }

        WidgetButton {
          id: button
          anchors.fill: parent
          bar: root.bar
          text: parent.focused ? "\uDB85\uDCFB" : (parent.modelData === 10 ? "0" : String(parent.modelData))
          foreground: parent.focused ? Color.accent : (root.bar ? root.bar.barForeground : Color.foreground)
          opacity: parent.occupied || parent.focused ? 1 : 0.5
          horizontalMargin: 6
          verticalPadding: 6
          fixedWidth: root.vertical ? root.barSize : Style.space(20)
          fixedHeight: root.barSize
          onPressed: function() { root.focusWorkspace(parent.modelData) }
        }
      }
    }
  }
}
