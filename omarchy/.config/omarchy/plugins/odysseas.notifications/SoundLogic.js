// Only native BB notifications opt in; never infer identity from message text.
function shouldChime(notification, dnd) {
  if (!notification || dnd) return false
  var hints = notification.hints || {}
  var suppressed = hints["suppress-sound"]
  if (suppressed === true || suppressed === 1 || suppressed === "true" || suppressed === "1") return false
  var desktop = String(hints["desktop-entry"] || "").toLowerCase().replace(/\.desktop$/, "")
  if (desktop) return desktop === "bb-desktop"
  return String(notification.appName || "").toLowerCase() === "bb"
}

function contentChanged(before, after) {
  return before.summary !== after.summary || before.body !== after.body
}

function canPlay(notification, dnd, running, now, lastPlayed) {
  return shouldChime(notification, dnd) && !running && now - lastPlayed >= 3000
}
