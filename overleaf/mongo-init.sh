#!/bin/sh
set -eu

until mongosh --host overleaf-mongo --quiet --eval \
  'db.adminCommand({ ping: 1 }).ok' | grep -q 1; do
  sleep 2
done

mongosh --host overleaf-mongo --quiet --eval '
try {
  rs.status();
} catch (error) {
  if (error.code === 94) {
    rs.initiate({
      _id: "overleaf",
      members: [{ _id: 0, host: "overleaf-mongo:27017" }]
    });
  } else {
    throw error;
  }
}
'

until mongosh --host overleaf-mongo --quiet --eval \
  'db.hello().isWritablePrimary' | grep -q true; do
  sleep 2
done
