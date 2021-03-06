/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as arrays from 'vs/base/common/arrays';
import { asThenable, first } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { EditorAction, IActionOptions, registerEditorAction, registerEditorContribution, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { ITextModel } from 'vs/editor/common/model';
import * as modes from 'vs/editor/common/modes';
import { DefaultSelectionRangeProvider } from 'vs/editor/contrib/smartSelect/defaultProvider';
import * as nls from 'vs/nls';
import { MenuId } from 'vs/platform/actions/common/actions';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';

class SelectionRanges {

	constructor(
		readonly index: number,
		readonly ranges: Range[]
	) { }

	mov(fwd: boolean): SelectionRanges {
		let index = this.index + (fwd ? 1 : -1);
		if (index < 0 || index >= this.ranges.length) {
			return this;
		}
		const res = new SelectionRanges(index, this.ranges);
		if (res.ranges[index].equalsRange(this.ranges[this.index])) {
			// next range equals this range, retry with next-next
			return res.mov(fwd);
		}
		return res;
	}
}

class SmartSelectController implements IEditorContribution {

	private static readonly _id = 'editor.contrib.smartSelectController';

	static get(editor: ICodeEditor): SmartSelectController {
		return editor.getContribution<SmartSelectController>(SmartSelectController._id);
	}

	private readonly _editor: ICodeEditor;

	private _state?: SelectionRanges;
	private _selectionListener?: IDisposable;
	private _ignoreSelection: boolean = false;

	constructor(editor: ICodeEditor) {
		this._editor = editor;
	}

	dispose(): void {
		dispose(this._selectionListener);
	}

	getId(): string {
		return SmartSelectController._id;
	}

	run(forward: boolean): Promise<void> | void {
		if (!this._editor.hasModel()) {
			return;
		}

		const selection = this._editor.getSelection();
		const model = this._editor.getModel();

		if (!modes.SelectionRangeRegistry.has(model)) {
			return;
		}


		let promise: Promise<void> = Promise.resolve(void 0);

		if (!this._state) {
			promise = provideSelectionRanges(model, selection.getStartPosition(), CancellationToken.None).then(ranges => {
				if (!arrays.isNonEmptyArray(ranges)) {
					// invalid result
					return;
				}
				if (!this._editor.hasModel() || !this._editor.getSelection().equalsSelection(selection)) {
					// invalid editor state
					return;
				}

				ranges = ranges.filter(range => {
					// filter ranges inside the selection
					return range.containsPosition(selection.getStartPosition()) && range.containsPosition(selection.getEndPosition());
				});

				// prepend current selection
				ranges.unshift(selection);

				this._state = new SelectionRanges(0, ranges);

				// listen to caret move and forget about state
				dispose(this._selectionListener);
				this._selectionListener = this._editor.onDidChangeCursorPosition(() => {
					if (!this._ignoreSelection) {
						dispose(this._selectionListener);
						this._state = undefined;
					}
				});
			});
		}

		return promise.then(() => {
			if (!this._state) {
				// no state
				return;
			}
			this._state = this._state.mov(forward);
			const selection = this._state.ranges[this._state.index];
			this._ignoreSelection = true;
			try {
				this._editor.setSelection(selection);
			} finally {
				this._ignoreSelection = false;
			}

		});
	}
}

abstract class AbstractSmartSelect extends EditorAction {

	private readonly _forward: boolean;

	constructor(forward: boolean, opts: IActionOptions) {
		super(opts);
		this._forward = forward;
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		let controller = SmartSelectController.get(editor);
		if (controller) {
			await controller.run(this._forward);
		}
	}
}

class GrowSelectionAction extends AbstractSmartSelect {
	constructor() {
		super(true, {
			id: 'editor.action.smartSelect.grow',
			label: nls.localize('smartSelect.grow', "Expand Select"),
			alias: 'Expand Select',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.RightArrow,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyMod.Shift | KeyCode.RightArrow },
				weight: KeybindingWeight.EditorContrib
			},
			menubarOpts: {
				menuId: MenuId.MenubarSelectionMenu,
				group: '1_basic',
				title: nls.localize({ key: 'miSmartSelectGrow', comment: ['&& denotes a mnemonic'] }, "&&Expand Selection"),
				order: 2
			}
		});
	}
}

class ShrinkSelectionAction extends AbstractSmartSelect {
	constructor() {
		super(false, {
			id: 'editor.action.smartSelect.shrink',
			label: nls.localize('smartSelect.shrink', "Shrink Select"),
			alias: 'Shrink Select',
			precondition: null,
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.LeftArrow,
				mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyMod.Shift | KeyCode.LeftArrow },
				weight: KeybindingWeight.EditorContrib
			},
			menubarOpts: {
				menuId: MenuId.MenubarSelectionMenu,
				group: '1_basic',
				title: nls.localize({ key: 'miSmartSelectShrink', comment: ['&& denotes a mnemonic'] }, "&&Shrink Selection"),
				order: 3
			}
		});
	}
}

registerEditorContribution(SmartSelectController);
registerEditorAction(GrowSelectionAction);
registerEditorAction(ShrinkSelectionAction);

export function provideSelectionRanges(model: ITextModel, position: Position, token: CancellationToken): Promise<Range[] | undefined | null> {
	const provider = modes.SelectionRangeRegistry.ordered(model);
	return first(provider.map(pro => () => asThenable(() => pro.provideSelectionRanges(model, position, token))), arrays.isNonEmptyArray);
}

modes.SelectionRangeRegistry.register('*', new DefaultSelectionRangeProvider());
