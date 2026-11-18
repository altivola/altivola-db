import { describe, expect, it } from 'vitest'
import { buildEdit, dialects, editInfoFor, editSummary, singleTableSelect } from '../src/edit.ts'
import { isLocalTarget, rewriteLocalhost } from '../src/hostalias.ts'
import { firstKeyword, splitQualified, splitSQL, splitTSQL } from '../src/sqlsplit.ts'

describe('splitSQL', () => {
  const cases: [string, string, string[]][] = [
    ['single without semicolon', 'select 1', ['select 1']],
    ['two statements', 'select 1; select 2;', ['select 1', 'select 2']],
    ['semicolon in string', "select 'a;b'; select 2", ["select 'a;b'", 'select 2']],
    ['doubled quote', "select 'it''s; fine'", ["select 'it''s; fine'"]],
    ['E string with backslash quote', "select E'a\\';b'; select 2", ["select E'a\\';b'", 'select 2']],
    ['quoted identifier', 'select 1 as "a;b"', ['select 1 as "a;b"']],
    ['line comment', 'select 1 -- ; not a split\n; select 2', ['select 1 -- ; not a split', 'select 2']],
    ['nested block comment', '/* a /* ; */ ; */ select 1', ['/* a /* ; */ ; */ select 1']],
    ['comment only statement dropped', 'select 1; -- trailing\n', ['select 1']],
    ['empty statements dropped', ';;select 1;;', ['select 1']],
    [
      'dollar quoted body',
      'create function f() returns int as $$ begin return 1; end $$ language plpgsql; select f()',
      ['create function f() returns int as $$ begin return 1; end $$ language plpgsql', 'select f()'],
    ],
    ['tagged dollar quote', 'select $x$ ; $$ ; $x$; select 2', ['select $x$ ; $$ ; $x$', 'select 2']],
    ['positional parameter is not a dollar quote', 'select $1; select 2', ['select $1', 'select 2']],
  ]
  for (const [name, input, want] of cases) {
    it(name, () => expect(splitSQL(input)).toEqual(want))
  }

  it('handles other dialects', () => {
    const my = splitSQL('select `a;b`, \'it\\\'s; x\', "q\\";" from t # ; comment\n; select 2', { mysql: true })
    expect(my).toHaveLength(2)
    expect(my[1]).toBe('select 2')
    expect(splitSQL('select [a;b] from [t]]x;]; select 2', { brackets: true })).toEqual([
      'select [a;b] from [t]]x;]',
      'select 2',
    ])
    expect(splitTSQL('select 1\nGO\nselect 2\n go \nselect 3; select 4')).toHaveLength(4)
  })
})

it('firstKeyword', () => {
  expect(firstKeyword('select 1')).toBe('select')
  expect(firstKeyword('  -- note\n  WITH x as (..)')).toBe('with')
  expect(firstKeyword('/* c */ (select 1)')).toBe('select')
  expect(firstKeyword('insert into t values (1)')).toBe('insert')
  expect(firstKeyword('')).toBe('')
})

it('splitQualified', () => {
  expect(splitQualified('`shop`.`users`')).toEqual(['shop', 'users'])
  expect(splitQualified('[dbo].[Or]]ders]')).toEqual(['dbo', 'Or]ders'])
  expect(splitQualified('main."my table"')).toEqual(['main', 'my table'])
  expect(() => splitQualified('a.')).toThrow()
})

it('rewriteLocalhost', () => {
  const alias = 'host.docker.internal'
  const cases: Record<string, string> = {
    'postgres://u:p@localhost:5432/app': 'postgres://u:p@host.docker.internal:5432/app',
    'postgres://u:p@127.0.0.1/app?sslmode=disable': 'postgres://u:p@host.docker.internal/app?sslmode=disable',
    'postgresql://LOCALHOST': 'postgresql://host.docker.internal',
    'postgres://u:p%40ss@db.internal:5432/localhost': 'postgres://u:p%40ss@db.internal:5432/localhost',
    'mongodb://localhost:27017,[::1]:27018,other:27019':
      'mongodb://host.docker.internal:27017,host.docker.internal:27018,other:27019',
    'mongodb://user:localhost@remote/db': 'mongodb://user:localhost@remote/db',
    'postgres:///app?host=/tmp': 'postgres:///app?host=/tmp',
  }
  for (const [input, want] of Object.entries(cases)) expect(rewriteLocalhost(input, alias)).toBe(want)
  expect(rewriteLocalhost('postgres://localhost/app', '')).toBe('postgres://localhost/app')
})

it('isLocalTarget', () => {
  const local = (url: string) => isLocalTarget({ url, kind: 'postgres' })
  expect(local('postgres://u:p@localhost:5432/app')).toBe(true)
  expect(local('postgres://u:p@127.0.0.1/app')).toBe(true)
  expect(local('postgres://u@[::1]:5432/app')).toBe(true)
  expect(local('postgres://u@host.docker.internal/app')).toBe(true)
  expect(local('mongodb://localhost:1,db.example.com:2/x')).toBe(false)
  expect(local('postgres://u:p@10.0.0.4/app')).toBe(false)
  expect(isLocalTarget({ url: 'sqlite:///tmp/a.db', kind: 'sqlite' })).toBe(true)
})

it('singleTableSelect', () => {
  const cases: Record<string, string | null> = {
    'select * from users': 'users',
    'SELECT id, name FROM public.users u WHERE id > 3 ORDER BY id LIMIT 10;': 'public.users',
    'select * from "My Table" limit 5': '"My Table"',
    'select top 10 * from [dbo].[Orders]': '[dbo].[Orders]',
    'select u.* from `shop`.`users` as u': '`shop`.`users`',
    'select count(*) from users': null,
    'select a.id from a join b on a.id = b.id': null,
    'select distinct name from users': null,
    'select name from users group by name': null,
    'select id, name as n from users': null,
    'update users set a = 1': null,
  }
  for (const [stmt, want] of Object.entries(cases)) expect(singleTableSelect(stmt), stmt).toBe(want)
})

it('buildEdit', () => {
  const u = buildEdit(dialects.postgres, 'public.users', {
    op: 'update',
    key: { id: '7' },
    values: { name: 'Ani', city: null },
  })
  expect(u.sql).toBe('update public.users set "city" = $1, "name" = $2 where "id" = $3')
  expect(u.args).toEqual([null, 'Ani', '7'])
  expect(buildEdit(dialects.sqlserver, '[dbo].[t]', { op: 'delete', key: { 'a]b': '1' } }).sql).toBe(
    'delete from [dbo].[t] where [a]]b] = @p1',
  )
  expect(buildEdit(dialects.mysql, '`t`', { op: 'insert', values: { b: '2', a: '1' } }).sql).toBe(
    'insert into `t` (`a`, `b`) values (?, ?)',
  )
  expect(buildEdit(dialects.postgres, 't', { op: 'delete', key: { k: null } }).sql).toBe(
    'delete from t where "k" is null',
  )
  expect(() => buildEdit(dialects.sqlite, 't', { op: 'delete' })).toThrow()
  expect(editSummary({ object: 't', ops: [{ op: 'delete' }, { op: 'update' }, { op: 'update' }] })).toBe(
    'updated 2, deleted 1',
  )
})

it('editInfoFor', () => {
  const cols = [{ name: 'ID' }, { name: 'name' }, { name: 'upper' }]
  const info = editInfoFor('t', '', cols, ['id', 'name'], ['id'])
  expect(info?.columns).toEqual(['id', 'name', ''])
  expect(info?.key).toEqual(['id'])
  expect(editInfoFor('t', '', cols.slice(1), ['id', 'name'], ['id'])).toBeUndefined()
})
