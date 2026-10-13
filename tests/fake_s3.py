"""Lo mínimo del cliente S3 de boto3 que usa tools/r2_sync.py, en memoria."""
import hashlib


class FakeS3:
    def __init__(self):
        self.objects = {}  # clave → (bytes, extras de put_object)
        self.puts = []

    def get_paginator(self, name):
        assert name == 'list_objects_v2'
        objects = self.objects

        class _Pages:
            def paginate(self, Bucket, Prefix):
                yield {'Contents': [{'Key': k, 'ETag': f'"{hashlib.md5(v[0]).hexdigest()}"'}
                                    for k, v in sorted(objects.items()) if k.startswith(Prefix)]}
        return _Pages()

    def put_object(self, Bucket, Key, Body, **extra):
        self.objects[Key] = (Body, extra)
        self.puts.append(Key)

    def get_object(self, Bucket, Key):
        import io
        return {'Body': io.BytesIO(self.objects[Key][0])}

    def delete_objects(self, Bucket, Delete):
        for o in Delete['Objects']:
            self.objects.pop(o['Key'], None)
