const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../routes/catalogRoutes');
const wooCommerceClient = require('../integration/wooCommerceClient');

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

test('brochure catalog can resolve active local Node brochure links', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const state = {
    byDoctorId: {
      doctor_1: {
        links: [
          {
            token: 'brochure-token',
            linkType: 'brochure',
            expiresAt: future,
            productScope: 'specific_products',
            allowedProducts: 'woo-1023, 1023',
          },
        ],
      },
    },
  };

  const link = __test__.findLocalLinkByTokenFromState(state, 'brochure-token');

  assert.equal(link.doctorId, 'doctor_1');
  assert.equal(link.linkType, 'brochure');
  assert.equal(link.capabilities.canViewPricing, false);
  assert.deepEqual(link.productScopeItems, ['woo-1023', '1023']);
});

test('brochure catalog rejects expired local Node links', () => {
  const expired = new Date(Date.now() - 60_000).toISOString();
  const state = {
    byDoctorId: {
      doctor_1: {
        links: [
          {
            token: 'expired-token',
            linkType: 'brochure',
            expiresAt: expired,
          },
        ],
      },
    },
  };

  assert.equal(__test__.findLocalLinkByTokenFromState(state, 'expired-token'), null);
});

test('brochure product scope supports parent products and variations', () => {
  const product = {
    id: 1023,
    sku: '',
    name: 'BPC-157 / TB-500 N',
    categories: [{ name: 'Vials', slug: 'vials' }],
    variations: [1071, { id: 1072, sku: 'BPC-TB-V' }],
  };

  assert.equal(__test__.brochureScopeMatches(product, { productScope: 'specific_products', productScopeItems: ['woo-1023'] }), true);
  assert.equal(__test__.brochureScopeMatches(product, { productScope: 'specific_products', productScopeItems: ['woo-variation-1071'] }), true);
  assert.equal(__test__.brochureScopeMatches(product, { productScope: 'specific_products', productScopeItems: ['bpc-tb-v'] }), true);
  assert.equal(__test__.brochureScopeMatches(product, { productScope: 'specific_products', productScopeItems: ['missing'] }), false);
});

test('brochure CSV rows map to product brochure info shape', () => {
  const rows = __test__.normalizeBrochureCsvRows([
    'Product Name,Product SKU,Product Description,Product Information,Sync Status',
    '"GLP, One",Phych-Sema-20mg-N,"Description, with comma","Benefits, with comma",UPSERTED',
  ].join('\n'));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_name, 'GLP, One');
  assert.equal(rows[0].product_sku, 'Phych-Sema-20mg-N');
  assert.equal(rows[0].product_description, 'Description, with comma');
  assert.equal(rows[0].product_information, 'Benefits, with comma');
  assert.equal(rows[0].parent_sku, 'Phych-Sema-20mg-N');
  assert.equal(rows[0].source, 'csv');
});

test('brochure CSV DTO remains brochure-safe and supports SKU scope', () => {
  const [row] = __test__.normalizeBrochureCsvRows([
    'Product Name,Product SKU,Product Description,Product Information,Sync Status',
    'GLP 1 20mg Nasal,Phych-Sema-20mg-N,Description,Benefits,UPSERTED',
  ].join('\n'));
  const dto = __test__.brochureDtoFromCsvRow(row);

  assert.equal(__test__.brochureRowScopeMatches(row, { productScope: 'specific_products', productScopeItems: ['phych-sema-20mg-n'] }), true);
  assert.equal(__test__.brochureRowScopeMatches(row, { productScope: 'specific_products', productScopeItems: ['missing'] }), false);
  assert.equal(dto.id, 'csv-phychsema20mgn');
  assert.equal(dto.sku, 'Phych-Sema-20mg-N');
  assert.equal(dto.category, 'Nasal / Oral Sprays (15ml White Bottle w/ Spray Top)');
  assert.equal(Object.prototype.hasOwnProperty.call(dto, 'price'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dto, 'stock_quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dto, 'checkout_url'), false);
});

test('brochure CSV scope resolves Woo product IDs through SKU or name matching', async () => {
  const rows = __test__.normalizeBrochureCsvRows([
    'Product Name,Product SKU,Product Description,Product Information,Sync Status',
    'BPC-157/TB500 10mg/10mg Nasal,Phych-BPC157-10mg-TB500-10mgN,Description,Benefits,UPSERTED',
  ].join('\n'));
  const previousFetchCatalog = wooCommerceClient.fetchCatalog;
  wooCommerceClient.fetchCatalog = async (endpoint) => {
    assert.equal(endpoint, 'products/1023');
    return {
      id: 1023,
      type: 'simple',
      sku: 'Phych-BPC157-10mg-TB500-10mgN',
      name: 'BPC-157 / TB-500 N',
      images: [{ src: 'https://example.test/bpc157.jpg' }],
    };
  };
  try {
    const scopedRows = await __test__.filterBrochureCsvRowsForScope(rows, {
      productScope: 'specific_products',
      productScopeItems: ['woo-1023'],
    });
    assert.equal(scopedRows.length, 1);
    assert.equal(scopedRows[0].product_sku, 'Phych-BPC157-10mg-TB500-10mgN');
    assert.equal(scopedRows[0].image_url, 'https://example.test/bpc157.jpg');
    const dto = __test__.brochureDtoFromCsvRow(scopedRows[0]);
    assert.equal(dto.imageUrl, 'https://example.test/bpc157.jpg');
    assert.equal(dto.wooProductId, 1023);
    assert.equal(dto.coaAvailable, true);
  } finally {
    wooCommerceClient.fetchCatalog = previousFetchCatalog;
  }
});

test('brochure CSV image hydration resolves Woo images for SKU-matched rows', async () => {
  const rows = __test__.normalizeBrochureCsvRows([
    'Product Name,Product SKU,Product Description,Product Information,Sync Status',
    'BPC-157/TB500 10mg/10mg Nasal,Phych-BPC157-10mg-TB500-10mgN,Description,Benefits,UPSERTED',
  ].join('\n'));
  const [scopedRow] = rows;
  const previousFetchCatalog = wooCommerceClient.fetchCatalog;
  const calls = [];
  wooCommerceClient.fetchCatalog = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'products') {
      return [{
        id: 1023,
        type: 'variable',
        sku: 'parent-bpc-tb',
        name: 'Parent product name that does not match directly',
        images: [{ src: 'https://example.test/parent.jpg' }],
      }];
    }
    if (endpoint === 'products/1023/variations') {
      return [{
        id: 1071,
        sku: 'Phych-BPC157-10mg-TB500-10mgN',
        name: 'BPC-157 / TB-500 N',
        image: { src: 'https://example.test/variation.jpg' },
      }];
    }
    return [];
  };
  try {
    const hydratedRows = await __test__.hydrateBrochureCsvRowsWithCatalogImages([scopedRow]);
    assert.equal(hydratedRows.length, 1);
    assert.equal(hydratedRows[0].image_url, 'https://example.test/variation.jpg');
    assert.equal(hydratedRows[0].product_id, 1023);
    assert.equal(hydratedRows[0].variation_id, 1071);
    assert.deepEqual(calls, ['products', 'products/1023/variations']);
  } finally {
    wooCommerceClient.fetchCatalog = previousFetchCatalog;
  }
});

test('local brochure fallback DTO remains brochure-safe', () => {
  const product = {
    id: 1023,
    name: 'BPC-157 / TB-500 N',
    sku: 'BPC-TB-N',
    price: '110.25',
    stock_quantity: 12,
    short_description: '<p>Recovery support information.</p>',
    attributes: [{ name: 'Strength', options: ['10mg / 10mg'] }],
    tags: [{ name: 'Healing' }],
    categories: [{ name: '10ml Amber Glass Vials', slug: 'vials' }],
  };

  const info = __test__.localBrochureInfoFromProduct(product);
  const dto = __test__.brochureDto(product, info, new Map());

  assert.equal(dto.sku, 'BPC-TB-N');
  assert.equal(dto.productDescription, 'Recovery support information.');
  assert.match(dto.productInformation, /Strength: 10mg \/ 10mg/);
  assert.equal(Object.prototype.hasOwnProperty.call(dto, 'price'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dto, 'stock_quantity'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dto, 'checkout_url'), false);
});
