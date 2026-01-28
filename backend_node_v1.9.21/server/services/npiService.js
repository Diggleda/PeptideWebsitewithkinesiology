const axios = require('axios');
const { logger } = require('../config/logger');

const CMS_NPI_REGISTRY_URL = 'https://npiregistry.cms.hhs.gov/api/';
const CMS_API_VERSION = '2.1';

const normalizeNpiNumber = (value) => {
  if (!value) {
    return '';
  }
  return String(value).replace(/[^0-9]/g, '').slice(0, 10);
};

const buildError = (message, status = 400, details) => {
  const error = new Error(message);
  error.status = status;
  if (details) {
    error.details = details;
  }
  return error;
};

const extractPrimaryTaxonomy = (taxonomies) => {
  if (!Array.isArray(taxonomies) || taxonomies.length === 0) {
    return null;
  }
  const primary =
    taxonomies.find((taxonomy) => String(taxonomy?.primary).toLowerCase() === 'true')
    || taxonomies[0];
  return (
    primary?.desc
    || primary?.classification
    || primary?.specialization
    || null
  );
};

const formatNameFromBasic = (basic) => {
  if (!basic) {
    return null;
  }
  if (basic.name && typeof basic.name === 'string') {
    return basic.name.trim() || null;
  }
  const parts = [basic.first_name, basic.middle_name, basic.last_name]
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
};

const verifyDoctorNpi = async (npiNumber) => {
  const normalized = normalizeNpiNumber(npiNumber);
  if (!/^\d{10}$/.test(normalized)) {
    throw buildError('NPI_INVALID', 400);
  }

  try {
    const response = await axios.get(CMS_NPI_REGISTRY_URL, {
      params: {
        version: CMS_API_VERSION,
        number: normalized,
      },
      timeout: 7000,
    });

    const { result_count: resultCount, results } = response?.data || {};
    if (!resultCount || !Array.isArray(results) || results.length === 0) {
      throw buildError('NPI_NOT_FOUND', 422);
    }

    const record = results[0];
    const basic = record?.basic || null;

    return {
      npiNumber: normalized,
      enumerationType: basic?.enumeration_type || record?.enumeration_type || null,
      name: formatNameFromBasic(basic),
      credential: basic?.credential || null,
      organizationName: basic?.organization_name || null,
      primaryTaxonomy: extractPrimaryTaxonomy(record?.taxonomies),
      raw: record,
    };
  } catch (error) {
    if (error?.message === 'NPI_INVALID' || error?.message === 'NPI_NOT_FOUND') {
      throw error;
    }

    const logPayload = {
      err: error,
      npiNumber: npiNumber ? String(npiNumber) : npiNumber,
    };

    if (axios.isAxiosError(error)) {
      logger.warn(logPayload, 'NPI registry lookup failed');
      throw buildError('NPI_LOOKUP_FAILED', 502, {
        status: error.response?.status,
        data: error.response?.data,
      });
    }

    logger.warn(logPayload, 'Unexpected error verifying NPI');
    throw buildError('NPI_LOOKUP_FAILED', 500);
  }
};

module.exports = {
  verifyDoctorNpi,
  normalizeNpiNumber,
};
