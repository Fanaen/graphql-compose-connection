/* @flow */
/* eslint-disable no-param-reassign, no-use-before-define */

import type {
  ResolveParams,
  ConnectionResolveParams,
  composeWithConnectionOpts,
  connectionSortOpts,
  CursorDataType,
  GraphQLConnectionType,
} from '../definition';
import { Resolver, TypeComposer } from 'graphql-compose';
import { GraphQLInt } from 'graphql';
import { prepareConnectionType } from '../types/connectionType';
import { prepareSortType } from '../types/sortInputType';
import Cursor from '../types/cursorType';

export function prepareConnectionResolver(
  typeComposer: TypeComposer,
  opts: composeWithConnectionOpts
): Resolver {
  if (!(typeComposer instanceof TypeComposer)) {
    throw new Error('First arg for Resolver connection() should be instance of TypeComposer');
  }

  if (!typeComposer.hasRecordIdFn()) {
    throw new Error(`TypeComposer(${typeComposer.getTypeName()}) should have recordIdFn. `
                  + 'This function returns ID from provided object.');
  }

  const countResolver = typeComposer.getResolver(opts.countResolverName);
  if (!countResolver) {
    throw new Error(`TypeComposer(${typeComposer.getTypeName()}) provided to composeWithConnection `
                  + `should have resolver with name '${opts.countResolverName}' `
                  + 'due opts.countResolverName.');
  }
  const countResolve = countResolver.composeResolve();

  const findManyResolver = typeComposer.getResolver(opts.findResolverName);
  if (!findManyResolver) {
    throw new Error(`TypeComposer(${typeComposer.getTypeName()}) provided to composeWithConnection `
                  + `should have resolver with name '${opts.findResolverName}' `
                  + 'due opts.countResolverName.');
  }
  const findManyResolve = findManyResolver.composeResolve();

  const additionalArgs = {};
  if (findManyResolver.hasArg('filter')) {
    additionalArgs.filter = findManyResolver.getArg('filter');
  }

  const sortEnumType = prepareSortType(typeComposer, opts);

  return new Resolver(typeComposer, {
    outputType: prepareConnectionType(typeComposer),
    name: 'connection',
    kind: 'query',
    args: {
      first: {
        type: GraphQLInt,
        description: 'Forward pagination argument for returning at most first edges',
      },
      after: {
        type: Cursor,
        description: 'Forward pagination argument for returning at most first edges',
      },
      last: {
        type: GraphQLInt,
        description: 'Backward pagination argument for returning at most last edges',
      },
      before: {
        type: Cursor,
        description: 'Backward pagination argument for returning at most last edges',
      },
      ...additionalArgs,
      sort: {
        type: sortEnumType,
        defaultValue: sortEnumType.getValues()[0].name, // first enum used by default
        description: 'Sort argument for data ordering',
      },
    },
    resolve: (resolveParams: ConnectionResolveParams) => {
      const { projection = {}, args = {} } = resolveParams;
      const findManyParams: ResolveParams = Object.assign(
        {},
        resolveParams,
        { args: {} } // clear this params in copy
      );
      const sortOptions: connectionSortOpts = args.sort;

      const first = parseInt(args.first, 10);
      const last = parseInt(args.last, 10);

      const limit = last || first;
      const skip = (first - last) || 0;

      findManyParams.args.limit = limit + 1; // +1 document, to check next page presence
      if (skip > 0) {
        findManyParams.args.skip = skip;
      }

      let filter = findManyParams.args.filter || {};
      const beginCursorData = cursorToData(args.after);
      if (beginCursorData) {
        filter = sortOptions.cursorToFilter(beginCursorData, filter);
      }
      const endCursorData = cursorToData(args.before);
      if (endCursorData) {
        filter = sortOptions.cursorToFilter(endCursorData, filter);
      }
      findManyParams.args.filter = filter;
      findManyParams.args.skip = skip;

      findManyParams.args.sort = sortOptions.sortValue;
      findManyParams.projection = projection;
      sortOptions.uniqueFields.forEach(fieldName => {
        findManyParams.projection[fieldName] = true;
      });

      let countPromise;
      if (projection.count) {
        countPromise = countResolve(resolveParams);
      }
      const hasPreviousPage = skip > 0;
      let hasNextPage = false; // will be requested +1 document, to check next page presence

      const filterDataForCursor = (record) => {
        const result = {};
        sortOptions.uniqueFields.forEach(fieldName => {
          result[fieldName] = record[fieldName];
        });
        return result;
      };

      return findManyResolve(findManyParams)
        .then(recordList => {
          const edges = [];
          // if returned more than `limit` records, strip array and mark that exists next page
          if (recordList.length > limit) {
            hasNextPage = true;
            recordList = recordList.slice(0, limit - 1);
          }
          // transform record to object { cursor, node }
          recordList.forEach(record => {
            edges.push({
              cursor: dataToCursor(filterDataForCursor(record)),
              node: record,
            });
          });
          return edges;
        })
        .then(async (edges) => {
          const result = emptyConnection();

          // pass `edge` data
          result.edges = edges;

          // if exists countPromise, await it's data
          if (countPromise) {
            result.count = await countPromise;
          }

          // pageInfo may be extended, so set data gradually
          if (edges.length > 0) {
            result.pageInfo.startCursor = edges[0].cursor;
            result.pageInfo.endCursor = edges[edges.length - 1].cursor;
            result.pageInfo.hasPreviousPage = hasPreviousPage;
            result.pageInfo.hasNextPage = hasNextPage;
          }

          return result;
        });
    },
  });
}

export function emptyConnection(): GraphQLConnectionType {
  return {
    count: 0,
    edges: [],
    pageInfo: {
      startCursor: '',
      endCursor: '',
      hasPreviousPage: false,
      hasNextPage: false,
    },
  };
}

export function cursorToData(id?: ?string): ?CursorDataType {
  if (id) {
    try {
      return JSON.parse(id) || null;
    } catch (err) {
      return null;
    }
  }
  return null;
}

export function dataToCursor(cursorData: CursorDataType): string {
  return JSON.stringify(cursorData);
}
