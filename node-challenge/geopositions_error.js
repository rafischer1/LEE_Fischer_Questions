'use strict';

const Promise = require('bluebird');
const gmAPI = require('../config/google-apis');
const PromiseThrottle = require('promise-throttle');
const Sequelize = require('sequelize');

// initialize the database connection to the local dev db
const sequelize = new Sequelize(
  'postgres://artiefischer@localhost:5432/leedemo'
);

const geocodeThrottle = new PromiseThrottle({
  requestsPerSecond: 40,
  promiseImplementation: Promise
});

const geopositions = sequelize.define(
  'Geoposition',
  {
    id: {
      type: Sequelize.INTEGER,
      field: 'id',
      primaryKey: true
    },

    query: {
      type: Sequelize.STRING
    },
    formattedAddress: {
      type: Sequelize.STRING,
      field: 'formatted_address'
    },
    lat: {
      type: Sequelize.DECIMAL
    },
    lng: {
      type: Sequelize.DECIMAL
    },
    premise: {
      type: Sequelize.STRING
    },
    subpremise: {
      type: Sequelize.STRING
    },
    streetNumber: {
      type: Sequelize.STRING,
      field: 'street_number'
    },
    route: {
      type: Sequelize.STRING
    },
    locality: {
      type: Sequelize.STRING
    },
    adminAreaLevel2: {
      type: Sequelize.STRING,
      field: 'admin_area_level_2'
    },
    adminAreaLevel1: {
      type: Sequelize.STRING,
      field: 'admin_area_level_1'
    },
    postalCode: {
      type: Sequelize.STRING,
      field: 'postal_code'
    },
    viewportN: {
      type: Sequelize.FLOAT,
      field: 'viewport_n'
    },
    viewportS: {
      type: Sequelize.FLOAT,
      field: 'viewport_s'
    },
    viewportW: {
      type: Sequelize.FLOAT,
      field: 'viewport_w'
    },
    viewportE: {
      type: Sequelize.FLOAT,
      field: 'viewport_e'
    },

    createdAt: {
      type: Sequelize.DATE,
      field: 'created'
    },
    updatedAt: {
      type: Sequelize.DATE,
      field: 'modified'
    }
  },
  {
    tableName: 'geopositions',
    classMethods: {
      associate: db => {},
      geocode: async function(query, allowPartial) {
        //Default allowPartial to true
        if (!allowPartial) {
          allowPartial = true;
        }

        //Uppercase, remove invalid characters, coalesce repeated spaces into a single space
        const upperAddress = query.toUpperCase();
        const sanitizedAddress = upperAddress.replace(/[^\x00-\x7F]/, '');
        const coalescedAddress = sanitizedAddress.replace(/\s/, '');

        //Check if address is empty, if so return error
        if (/^\s+$/.test(coalescedAddress)) {
          return {
            status: false,
            statusCode: 'EMPTY_ADDRESS'
          };
        }

        if (allowPartial) {
          let cached = await geopositions.findAll({
            where: {
              query: coalescedAddress
            }
          });

          if (cached) {
            cached = cached.get();
            cached.status = true;
            cached.statusCode = 'CACHED';
            return cached;
          }
        }

        let result = await geocodeThrottle.add(
          gmAPI.geocodeAsync.bind(gmAPI, {
            address: coalescedAddress
          })
        );

        //If rate limit exceeded, throw error to force retry
        if (result.status === 'OVER_QUERY_LIMIT') {
          throw new Error('OVER_QUERY_LIMIT');
        }

        if (result.status !== 'OK') {
          return {
            status: false,
            statusCode: result.status
          };
        }

        if (allowPartial) {
          result = result.results[0];
        } else {
          //Filter result to disallow partial matches
          result = result.results.filter(row => {
            if (!row.partial_match) {
              return true;
            }
          });

          //If no results, return error
          if (!result) {
            return {
              status: false,
              statusCode: 'NO_EXACT'
            };
          }
        }

        const formattedAddress = result.formatted_address;
        const lat = result.geometry.location.lat;
        const lng = result.geometry.location.lng;

        //Generate model properties
        const address = {
          query: coalescedAddress,
          formattedAddress: formattedAddress,
          latitude: lat,
          longitude: lng,
          premise: '',
          subpremise: '',
          streetNumber: '',
          route: '',
          locality: '',
          adminAreaLevel2: '',
          adminAreaLevel1: '',
          postalCode: ''
        };

        //address_components ~ {types: string[], long_name: string}[]
        //Find relevant properties in address_components and assign to
        result.address_components.forEach(component => {
          if (component.types.some(type => type === 'premise')) {
            address.premise = component.long_name;
          } else if (component.types.some(type => type === 'subpremise')) {
            address.subpremise = component.long_name;
          } else if (component.types.some(type => type === 'street_number')) {
            address.streetNumber = component.long_name;
          } else if (component.types.some(type => type === 'route')) {
            address.route = component.long_name;
          } else if (component.types.some(type => type === 'locality')) {
            address.locality = component.long_name;
          } else if (
            component.types.some(type => type === 'administrative_area_level_2')
          ) {
            address.adminAreaLevel2 = component.long_name;
          } else if (
            component.types.some(type => type === 'administrative_area_level_1')
          ) {
            address.adminAreaLevel1 = component.short_name;
          } else if (component.types.some(type => type === 'postal_code')) {
            address.postalCode = component.long_name;
          }
        });

        // add google api coordinates to the address object
        address.viewportN = result.geometry.viewport.northeast.lat;
        address.viewportE = result.geometry.viewport.northeast.lng;
        address.viewportS = result.geometry.viewport.southwest.lat;
        address.viewportW = result.geometry.viewport.southwest.lng;

        // INSERT INTO TABLE geopositions ... the new address object
        await geopositions.create(address);
        return address;
      }
    }
  }
);

module.exports = geopositions;
