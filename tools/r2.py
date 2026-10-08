"""R2 (API S3) para las herramientas de Grilla web que corren en GitHub."""


class R2:
    """Lo mínimo de R2 (API S3) que hace falta. Los tests lo reemplazan por uno en memoria."""

    def __init__(self, client, bucket):
        self.client, self.bucket = client, bucket

    def get(self, key):
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=key)
        except self.client.exceptions.NoSuchKey:
            return None
        return obj['Body'].read(), obj['LastModified']

    def put(self, key, body):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType='application/json')

    def keys(self, prefix):
        for page in self.client.get_paginator('list_objects_v2').paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get('Contents', []):
                yield obj['Key']

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)
