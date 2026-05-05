const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../routes/catalogRoutes');

const withEnv = (patch, fn) => {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
};

test('catalog recommendation limit does not expand to the whole product catalog', () => {
  withEnv({ RECOMMENDATION_MAX_RESULTS: null }, () => {
    assert.equal(__test__.resolveRecommendationLimit('100'), 24);
    assert.equal(__test__.resolveRecommendationLimit('500'), 24);
    assert.equal(__test__.resolveRecommendationLimit('4'), 4);
    assert.equal(__test__.resolveRecommendationLimit(undefined), 12);
  });
});

test('catalog recommendation limit honors a smaller configured maximum', () => {
  withEnv({ RECOMMENDATION_MAX_RESULTS: '8' }, () => {
    assert.equal(__test__.resolveRecommendationLimit('100'), 8);
  });
});

test('simulation recommendations are capped separately from the response limit', () => {
  withEnv({ RECOMMENDATION_SIMULATION_LIMIT: null }, () => {
    assert.equal(__test__.resolveSimulationLimit(24), 6);
    assert.equal(__test__.resolveSimulationLimit(3), 3);
  });
  withEnv({ RECOMMENDATION_SIMULATION_LIMIT: '50' }, () => {
    assert.equal(__test__.resolveSimulationLimit(24), 12);
  });
});
