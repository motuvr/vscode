/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { FoldingRangeProvider, FoldingRange, FoldingContext } from 'vs/editor/common/modes';
import { onUnexpectedExternalError } from 'vs/base/common/errors';
import { toThenable } from 'vs/base/common/async';
import { ITextModel } from 'vs/editor/common/model';
import { RangeProvider } from './folding';
import { TPromise } from 'vs/base/common/winjs.base';
import { MAX_LINE_NUMBER, FoldingRegions } from './foldingRanges';
import { CancellationToken } from 'vs/base/common/cancellation';

const MAX_FOLDING_REGIONS_FOR_INDENT_LIMIT = 5000;

export interface IFoldingRangeData extends FoldingRange {
	rank: number;
}

const foldingContext: FoldingContext = {
	maxRanges: MAX_FOLDING_REGIONS_FOR_INDENT_LIMIT
};

export class SyntaxRangeProvider implements RangeProvider {

	constructor(private providers: FoldingRangeProvider[]) {
	}

	compute(model: ITextModel, cancellationToken: CancellationToken): Thenable<FoldingRegions> {
		return collectSyntaxRanges(this.providers, model, cancellationToken).then(ranges => {
			if (ranges) {
				let res = sanitizeRanges(ranges);
				return res;
			}
			return null;
		});
	}

}

function collectSyntaxRanges(providers: FoldingRangeProvider[], model: ITextModel, cancellationToken: CancellationToken): Thenable<IFoldingRangeData[] | null> {
	let promises = providers.map(provider => toThenable(provider.provideFoldingRanges(model, foldingContext, cancellationToken)));
	return TPromise.join(promises).then(results => {
		let rangeData: IFoldingRangeData[] = null;
		if (cancellationToken.isCancellationRequested) {
			return null;
		}
		for (let i = 0; i < results.length; i++) {
			let ranges = results[i];
			if (Array.isArray(ranges)) {
				if (!Array.isArray(rangeData)) {
					rangeData = [];
				}
				let nLines = model.getLineCount();
				for (let r of ranges) {
					if (r.start > 0 && r.end > r.start && r.end <= nLines) {
						rangeData.push({ start: r.start, end: r.end, rank: i, kind: r.kind });
					}
				}
			}
		}
		return rangeData;

	}, onUnexpectedExternalError);
}

export class RangesCollector {
	private _startIndexes: number[];
	private _endIndexes: number[];
	private _nestingLevels: number[];
	private _nestingLevelCounts: number[];
	private _types: string[];
	private _length: number;
	private _foldingRangesLimit: number;

	constructor(foldingRangesLimit: number) {
		this._startIndexes = [];
		this._endIndexes = [];
		this._nestingLevels = [];
		this._nestingLevelCounts = [];
		this._types = [];
		this._length = 0;
		this._foldingRangesLimit = foldingRangesLimit;
	}

	public add(startLineNumber: number, endLineNumber: number, type: string, nestingLevel: number) {
		if (startLineNumber > MAX_LINE_NUMBER || endLineNumber > MAX_LINE_NUMBER) {
			return;
		}
		let index = this._length;
		this._startIndexes[index] = startLineNumber;
		this._endIndexes[index] = endLineNumber;
		this._nestingLevels[index] = nestingLevel;
		this._types[index] = type;
		this._length++;
		if (nestingLevel < 30) {
			this._nestingLevelCounts[nestingLevel] = (this._nestingLevelCounts[nestingLevel] || 0) + 1;
		}
	}

	public toIndentRanges() {
		if (this._length <= this._foldingRangesLimit) {
			let startIndexes = new Uint32Array(this._length);
			let endIndexes = new Uint32Array(this._length);
			for (let i = 0; i < this._length; i++) {
				startIndexes[i] = this._startIndexes[i];
				endIndexes[i] = this._endIndexes[i];
			}
			return new FoldingRegions(startIndexes, endIndexes, this._types);
		} else {
			let entries = 0;
			let maxLevel = this._nestingLevelCounts.length;
			for (let i = 0; i < this._nestingLevelCounts.length; i++) {
				let n = this._nestingLevelCounts[i];
				if (n) {
					if (n + entries > this._foldingRangesLimit) {
						maxLevel = i;
						break;
					}
					entries += n;
				}
			}
			let startIndexes = new Uint32Array(entries);
			let endIndexes = new Uint32Array(entries);
			let types = [];
			for (let i = 0, k = 0; i < this._length; i++) {
				let level = this._nestingLevels[i];
				if (level < maxLevel) {
					startIndexes[k] = this._startIndexes[i];
					endIndexes[k] = this._endIndexes[i];
					types[k] = this._types[i];
					k++;
				}
			}
			return new FoldingRegions(startIndexes, endIndexes, types);
		}

	}

}

export function sanitizeRanges(rangeData: IFoldingRangeData[]): FoldingRegions {

	let sorted = rangeData.sort((d1, d2) => {
		let diff = d1.start - d2.start;
		if (diff === 0) {
			diff = d1.rank - d2.rank;
		}
		return diff;
	});
	let collector = new RangesCollector(MAX_FOLDING_REGIONS_FOR_INDENT_LIMIT);

	let top: IFoldingRangeData = null;
	let previous = [];
	for (let entry of sorted) {
		if (!top) {
			top = entry;
			collector.add(entry.start, entry.end, entry.kind && entry.kind.value, previous.length);
		} else {
			if (entry.start > top.start) {
				if (entry.end <= top.end) {
					previous.push(top);
					top = entry;
					collector.add(entry.start, entry.end, entry.kind && entry.kind.value, previous.length);
				} else if (entry.start > top.end) {
					do {
						top = previous.pop();
					} while (top && entry.start > top.end);
					previous.push(top);
					top = entry;
					collector.add(entry.start, entry.end, entry.kind && entry.kind.value, previous.length);
				}
			}
		}
	}
	return collector.toIndentRanges();
}