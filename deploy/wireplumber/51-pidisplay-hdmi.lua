-- PiDisplay: prefer the screen's HDMI speakers over the 3.5mm jack (WirePlumber 0.4).
-- The HDMI sink is recreated under a new name whenever the screen reconnects, so a
-- saved default can't hold it; a higher priority makes WirePlumber pick it every time.
table.insert(alsa_monitor.rules, {
  matches = { { { "node.name", "matches", "alsa_output.*hdmi*" } } },
  apply_properties = { ["priority.session"] = 2000, ["priority.driver"] = 2000 },
})
