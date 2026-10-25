import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { REQUIRED_PERMISSION_KEY } from '../iam/require-permission.decorator';
import { InventoryController } from './inventory.controller';

describe('InventoryController cycle-count list authorization', () => {
  const handlerMetadata = (methodName: string, metadataKey: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(InventoryController.prototype, methodName);
    if (!descriptor?.value) throw new Error(`Missing InventoryController.${methodName}`);
    return Reflect.getMetadata(metadataKey, descriptor.value);
  };

  it('keeps the ordinary cycle-count list read-only and redacted by default', () => {
    expect(handlerMetadata('listCycleCounts', REQUIRED_PERMISSION_KEY)).toBe('inventory.read');
    expect(handlerMetadata('listCycleCounts', METHOD_METADATA)).toBe(RequestMethod.GET);
    expect(handlerMetadata('listCycleCounts', PATH_METADATA)).toBe(':itemId/cycle-counts');
  });

  it('requires the dedicated cycle-count review permission to list expected blind-count snapshots', () => {
    expect(handlerMetadata('listCycleCountsForReview', REQUIRED_PERMISSION_KEY))
      .toBe('inventory.cycle-count.review');
    expect(handlerMetadata('listCycleCountsForReview', METHOD_METADATA)).toBe(RequestMethod.GET);
    expect(handlerMetadata('listCycleCountsForReview', PATH_METADATA))
      .toBe(':itemId/cycle-counts/review');
  });
});
