# Native revisions and multiple comments

Open **Review** in the editor header. Select a passage or part of a formula, choose **Annotate selection**, enter a comment, and click **Add comment**. Repeat at other locations. Check the comments you want to discuss, then click **add comments to chat** to attach all of them in one context update. Type and send your request normally; attaching comments leaves the chat draft unchanged and does not send a message.

**Go to text** returns to a comment's native note and highlights the original quote when it still directly precedes that note. Formula comments return to the containing formula. **Resolve** retains a comment in the document; **Reopen** makes it active again. New open comments are checked by default. A new selection or batch attachment replaces this panel's previous chat context.

Comments use ordinary LyX Note insets, initially collapsed. Their ID, status, original quote, and comment body are stored in the `.lyx` document. Save explicitly to persist them. They remain editable in desktop LyX and do not appear in LaTeX/PDF output. Adding and resolving comments use native undo. The note follows surrounding document edits, but it is a point anchor, not a permanently tracked text range. If the quote changes, navigation may place the cursor beside the note without selecting text. If a note is copied with the same ID, review refuses ambiguous navigation or attachment.

## Review proposed edits

Both model replacement tools default to native tracked changes. **Previous change**, **Next change**, **Accept**, and **Reject** use LyX's native revision actions. **Track my edits** separately controls tracking for manual edits; AI replacements leave that preference unchanged. An explicit direct-edit request can use `trackChanges:false`, while a document with manual tracking enabled still records its edits.

LyX tracks a formula as a whole inset. An AI replacement inside a formula therefore preserves a complete deleted original and a complete inserted replacement, both editable. Accept or reject the existing formula revisions before proposing another tracked edit inside that formula. This preserves the expression for review; it does not verify mathematical correctness. Review both parts of a replacement with the change-navigation controls.

Edits and comment creation verify the document path, source revision, and intended selection. A draft comment retains the selection captured by **Annotate selection**. If the document or selection changes before submission, the operation is rejected and the draft remains available. Native menus, dialogs, and pending input composition block review mutations. No review operation saves automatically.

## Model tools and updates

`read_native_lyx` includes review state and native comment anchors. `review_native_lyx` supports comment creation, location, resolution, change navigation, acceptance/rejection, and the manual tracking preference. Comment anchors in an attachment are not replacement ranges: read the current document and establish the intended selection before editing. Saved selection edits retain their cursor-independent snapshot behavior. An identical retry must use the same snapshot ID, replacement, and `trackChanges` value.

Rebuild the native engine and web bundle after updating this source checkout. Existing native sessions keep their previous engine. Mounted panels keep their previous JavaScript, and the running MCP service keeps its previous tool catalog. Save documents before closing old sessions; reload the plugin service and reopen the panel to load all layers. A new service refuses tracked edits on an older engine rather than silently applying an untracked edit. See [updating a running checkout](compatibility.md#updating-a-running-checkout).

## Verification

Background comment polling leaves button states and existing cards unchanged when their data is unchanged. Read-only queries also preserve the idle frame cadence and prepared selection clipboard. The editor uses the height allocated by its host and disables the MCP Apps SDK's automatic content-height reporting. Otherwise the SDK measures the full comment list at `max-content` height and can ask Codex to enlarge an editor that should scroll internally. `node test/native-host-size.browser.mjs` serves a real-SDK browser comparison: open Review and run the resize regression on `/before` and `/after`. The latter must keep rendering different native sizes without sending host height requests.

On 2026-10-23, live panel inspection found both an old bundle with automatic height reporting and a rebuilt bundle mounted simultaneously; both reported themselves visible and continued polling. After saving, closing all LyX tabs and reopening the original file once, the user confirmed that the right-hand scrollbar no longer flickered. This confirms the scrollbar fix in actual use; a rebuilt file alone does not update already-mounted panels.

Automated coverage exercises the actual frontend bundle's checked-comment batch attachment, document-switch cleanup, MCP schema/default tracking behavior, and a real stdio MCP/native snapshot edit with tracked retry and undo. Native regressions cover text acceptance/rejection, nested formula revisions, multiple comments, Chinese comment text, stale requests, native dialog guards, undo, save/reopen, and exclusion from LaTeX export. Color formatting and native IME regressions also pass with the merged engine.

Manual checks in the standalone editor cover two Chinese comments, folded native notes, original-text navigation, resolve/reopen, and explicit saving. The current Codex host's batch attachment has not been manually verified: opening its panel returned a queued acknowledgement while this chat was not displayed. The standalone check and automated host adapter do not establish that final host interaction.
