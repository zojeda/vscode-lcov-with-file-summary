'use strict';

import * as vscode from 'vscode';

import {DataBank} from './dataBank';
import {BranchCoverage, Configuration} from './configuration';
import {ICoverageData, IRawLineCoverageDetail, IRawBranchCoverageDetail} from './loader';
import {Enablement} from './enablement';

export class EditorDecorator {

	private _config: Configuration;
	private _dataBank: DataBank;

	private _coveredLineDecType: vscode.TextEditorDecorationType;
	private _missedLineDecType: vscode.TextEditorDecorationType;
	private _coveredBranchDecType: vscode.TextEditorDecorationType;
	private _missedBranchDecType: vscode.TextEditorDecorationType;
	private _partialBranchDecType: vscode.TextEditorDecorationType;
	private _listener: vscode.Disposable;
	private _enablementListener: vscode.Disposable;

	constructor(config: Configuration, dataBank: DataBank) {
		this._config = config;
		this._dataBank = dataBank;

		this._dataBank.onDidChange(() => this._updateEditors());

		// decoration type for covered lines
		this._coveredLineDecType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(208,233,153,0.4)',
			isWholeLine: true
		});

		// decoration type for missed lines
		this._missedLineDecType = vscode.window.createTextEditorDecorationType({
			backgroundColor: 'rgba(216,134,123,0.4)',
			isWholeLine: true,
			overviewRulerColor: 'rgba(216,134,123,0.8)',
			overviewRulerLane: vscode.OverviewRulerLane.Left
		});

		// decoration type for covered branches
		this._coveredBranchDecType = vscode.window.createTextEditorDecorationType({
			before: {
				backgroundColor: 'lightgreen',
				color: 'darkgreen',
			}
		});

		// decoration type for missed branches
		this._missedBranchDecType = vscode.window.createTextEditorDecorationType({
			before: {
				backgroundColor: 'darkred',
				color: 'white',
			},
			overviewRulerColor: 'rgba(216,134,123,0.8)',
			overviewRulerLane: vscode.OverviewRulerLane.Left
		});

		// decoration type for partial branches
		this._partialBranchDecType = vscode.window.createTextEditorDecorationType({
			before: {
				backgroundColor: 'black',
				color: 'white',
			},
			overviewRulerColor: 'rgba(216,134,123,0.8)',
			overviewRulerLane: vscode.OverviewRulerLane.Left
		});

		// watcher to update decorations
		this._listener = vscode.window.onDidChangeActiveTextEditor(() => this._updateEditors());
		this._enablementListener = Enablement.onDidChange(() => this._updateEditors());
	}

	public dispose(): void {
		this._coveredLineDecType.dispose();
		this._missedLineDecType.dispose();
		this._coveredBranchDecType.dispose();
		this._missedBranchDecType.dispose();
		this._partialBranchDecType.dispose();
		this._listener.dispose();
		this._enablementListener.dispose();
	}

	private _updateEditors(): void {
		vscode.window.visibleTextEditors.forEach(textEditor => {
			let uri = textEditor.document.uri;
			let data = this._dataBank.get(uri);
			if (data) {
				this._updateEditor(textEditor, data);
			}
		});
	}

	private _updateEditor(editor:vscode.TextEditor, data: ICoverageData): void {
		if (Enablement.value()) {
			let lineCov = computeLineCoverageDecorations(data.lines.details);
			editor.setDecorations(this._coveredLineDecType, lineCov.covered);
			editor.setDecorations(this._missedLineDecType, lineCov.missed);

			let branchCov = computeBranchCoverageDecorations(this._config.branchCoverage, editor.document, data.branches.details);
			editor.setDecorations(this._coveredBranchDecType, branchCov.covered);
			editor.setDecorations(this._missedBranchDecType, branchCov.missed);
			editor.setDecorations(this._partialBranchDecType, branchCov.partial);
		} else {
			editor.setDecorations(this._coveredLineDecType, []);
			editor.setDecorations(this._missedLineDecType, []);
			editor.setDecorations(this._coveredBranchDecType, []);
			editor.setDecorations(this._missedBranchDecType, []);
			editor.setDecorations(this._partialBranchDecType, []);
		}
	}
}

interface ILineCoverageDecorations {
	covered: vscode.Range[];
	missed: vscode.Range[];
}

function computeLineCoverageDecorations(lines: IRawLineCoverageDetail[]):ILineCoverageDecorations {
	if (!lines || lines.length === 0) {
		return {
			covered: [],
			missed: []
		};
	}

	let toLineRange = (detail:{line:number;}) => new vscode.Range(detail.line - 1, 0, detail.line - 1, 0);
	let coveredLines = lines.filter(detail => detail.hit > 0);
	let missedLines = lines.filter(detail => detail.hit === 0);

	return {
		covered: coveredLines.map(toLineRange),
		missed: missedLines.map(toLineRange)
	};
}

interface IBranchCoverageDecorations {
	covered:vscode.DecorationOptions[];
	missed:vscode.DecorationOptions[];
	partial:vscode.DecorationOptions[];
}

function computeBranchCoverageDecorations(branchCoverage: BranchCoverage, document:vscode.TextDocument, branches:IRawBranchCoverageDetail[]): IBranchCoverageDecorations {
	if (!branches || branches.length === 0 || branchCoverage === BranchCoverage.Off) {
		return {
			covered: [],
			missed: [],
			partial: []
		};
	}

	let branchesMap:{[line:string]:boolean[][]} = {};

	let pushGroup = (group:IRawBranchCoverageDetail[]) => {
		let strLineNumber = String(group[0].line);
		branchesMap[strLineNumber] = branchesMap[strLineNumber] || [];
		branchesMap[strLineNumber].push(group.map(b => b.taken > 0));
	};
	let group:IRawBranchCoverageDetail[] = [];
	group.push(branches[0]);
	for (let i = 1; i < branches.length; i++) {
		let prev = group[group.length - 1];
		let current = branches[i];

		if (current.block === prev.block) {
			group.push(current);
		} else {
			pushGroup(group);
			group = [current];
		}
	}
	pushGroup(group);

	let covered:vscode.DecorationOptions[] = [];
	let missed:vscode.DecorationOptions[] = [];
	let partial:vscode.DecorationOptions[] = [];

	let pushResult = (dest:vscode.DecorationOptions[], lineNumber:number, text:string) => {
		let line = document.lineAt(lineNumber - 1);
		dest.push({
			range: new vscode.Range(line.lineNumber, line.firstNonWhitespaceCharacterIndex, line.lineNumber, line.firstNonWhitespaceCharacterIndex),
			renderOptions: {
				before: {
					contentText: text
				}
			}
		});
	}

	Object.keys(branchesMap).forEach((strLineNumber) => {
		let branchesAtLine = branchesMap[strLineNumber];
		let lineNumber = parseInt(strLineNumber, 10);

		let pieces:string[] = [];
		let totalCnt = 0;
		let takenCnt = 0;

		if (branchCoverage === BranchCoverage.Simple) {
			if (branchesAtLine.length > 1) {
				branchesAtLine = branchesAtLine.slice(0, 1);
			}
			if (branchesAtLine[0].length !== 2) {
				return;
			}
			let ifBranchTaken = branchesAtLine[0][0];
			let elseBranchTaken = branchesAtLine[0][1];

			if (ifBranchTaken && elseBranchTaken) {
				pushResult(covered, lineNumber, '✓');
			}
			if (ifBranchTaken && !elseBranchTaken) {
				pushResult(partial, lineNumber, ' E ');
			}
			if (!ifBranchTaken && elseBranchTaken) {
				pushResult(partial, lineNumber, ' I ');
			}
			if (!ifBranchTaken && !elseBranchTaken) {
				pushResult(missed, lineNumber, '∅');
			}
			return;
		}

		for (let i = 0; i < branchesAtLine.length; i++) {
			let branch = branchesAtLine[i];

			totalCnt += branch.length;
			for (let j = 0; j < branch.length; j++) {
				let condition = branch[j];
				if (condition) {
					takenCnt++;
				}
			}

			pieces.push(branch.map((taken) => {
				return taken ? '✓' : '∅';
			}).join(''));
		}

		let dest:vscode.DecorationOptions[];
		if (totalCnt === takenCnt) {
			// Good Job, Sir!
			dest = covered;
		} else if (takenCnt === 0) {
			// Uh, oh
			dest = missed;
		} else {
			dest = partial;
		}

		if (pieces.length === 1) {
			// simple boolean condition
			if (pieces[0] === '✓∅') {
				// else branch was missed
				pieces[0] = ' E ';
			} else if (pieces[0] === '∅✓') {
				// if branch was missed
				pieces[0] = ' I ';
			}
		}

		pushResult(dest, lineNumber, pieces.join('—'));
	});

	return {
		covered: covered,
		missed: missed,
		partial: partial
	};
}
