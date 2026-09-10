import QtQuick
import Quickshell
import qs.Ui

BarWidget {
  id: root
  moduleName: "command-space.launcher"
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "\ue900"
    fontFamily: "omarchy"
    horizontalMargin: 7.5
    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton && root.bar) root.bar.run("xdg-terminal-exec")
      else Quickshell.execDetached([Quickshell.env("HOME") + "/.local/bin/command-space", "toggle"])
    }
  }
}
