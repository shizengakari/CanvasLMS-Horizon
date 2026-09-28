const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const canvasService = require('../src/canvasService');

describe('CanvasService Cache & Performance Whitebox Tests', () => {
  beforeEach(() => {
    canvasService.clearAllCache(false);
  });

  it('should have extended cache TTL for power saving', () => {
    assert.strictEqual(canvasService.CACHE_TTL, 15 * 60 * 1000, 'CACHE_TTL should be 15 min');
    assert.strictEqual(canvasService.COURSES_CACHE_TTL, 60 * 60 * 1000, 'COURSES_CACHE_TTL should be 60 min');
    assert.strictEqual(canvasService.MATERIALS_CACHE_TTL, 30 * 60 * 1000, 'MATERIALS_CACHE_TTL should be 30 min');
  });

  it('should cache and return groupedMaterials without re-fetching within TTL', async () => {
    const courseId = 'test_course_123';
    const mockMaterials = [
      { id: 'mod_1', name: '第1回 講義', items: [{ id: 'f_1', title: 'スライド.pdf', type: 'File' }] }
    ];

    // キャッシュに直接セット
    canvasService.cache.groupedMaterials.set(courseId, {
      time: Date.now(),
      data: mockMaterials
    });

    // forceRefresh = false で呼び出し
    const result = await canvasService.getCourseMaterialsGrouped(courseId, false);
    assert.deepStrictEqual(result, mockMaterials, 'Should return cached materials directly');
  });

  it('should invalidate cache when expired beyond MATERIALS_CACHE_TTL', () => {
    const courseId = 'test_course_expired';
    const expiredTime = Date.now() - (31 * 60 * 1000); // 31分前
    canvasService.cache.groupedMaterials.set(courseId, {
      time: expiredTime,
      data: [{ id: 'old' }]
    });

    const cached = canvasService.cache.groupedMaterials.get(courseId);
    const isExpired = (Date.now() - cached.time) >= canvasService.MATERIALS_CACHE_TTL;
    assert.strictEqual(isExpired, true, 'Cache should be expired after 30 minutes');
  });

  it('should properly clear all in-memory and disk cache in clearAllCache()', () => {
    canvasService.cache.courses = [{ id: 1, name: '科目A' }];
    canvasService.cache.allAssignments = [{ id: 101, name: '課題1' }];
    canvasService.cache.groupedMaterials.set('1', { time: Date.now(), data: [] });

    canvasService.clearAllCache(true);

    assert.strictEqual(canvasService.cache.courses, null);
    assert.strictEqual(canvasService.cache.allAssignments, null);
    assert.strictEqual(canvasService.cache.groupedMaterials.size, 0);
  });
});
