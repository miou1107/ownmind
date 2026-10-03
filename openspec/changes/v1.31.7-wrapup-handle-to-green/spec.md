# Spec — handling wrap-up tiles to green

GIVEN a wrap-up ran and the 版號 tile is yellow
WHEN the model calls mcp__wrapup-check__resolve with item 版號 and a sentence
THEN the checks run again, the 版號 tile is green and shows that sentence,
AND the answer names every tile that is still not green, or says all six are green.

GIVEN the 分支 tile is red
WHEN the model calls resolve with item 分支
THEN the call is refused with the row's detail, and the tile stays red.

GIVEN the model fixed what made a tile red
WHEN the checks run again
THEN that tile is green without any resolve call.

GIVEN an item name not on the pane, or an empty sentence
WHEN the model calls resolve
THEN the call is refused and nothing changes.

GIVEN tiles were resolved
WHEN the user presses 再查一次
THEN they stay green unless the check now finds them red.
WHEN the user types a wrap-up word again
THEN every resolution is dropped and the checks start over.

GIVEN agy is listening on a port while it judges a reply
WHEN the residue check runs
THEN that port is not reported.

GIVEN the 版號 tile was resolved
WHEN another commit lands and the checks run again
THEN the tile is yellow again, because its detail changed.

GIVEN a prompt whose origin is a task notification, a peer session or a scheduled trigger
WHEN its text contains a wrap-up word
THEN nothing runs and no pane opens.
