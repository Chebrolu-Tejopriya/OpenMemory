"""Exercise the actual downloader gate without downloading models or remote images."""
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend', 'python'))
import embed_server


class Vector:
    def tolist(self):
        return [0.1] * 512


class Model:
    def embed(self, paths, batch_size):
        return [Vector() for _ in paths]


class ImageHostsTest(unittest.TestCase):
    def test_pinterest_and_x_media_produce_vectors(self):
        def download(_url):
            handle, path = tempfile.mkstemp()
            os.close(handle)
            return path

        urls = ['https://i.pinimg.com/236x/a.jpg', 'https://pbs.twimg.com/media/a.jpg',
                'https://video.twimg.com/thumb/a.jpg', 'https://pbs.twimg.com.evil.example/a.jpg',
                'http://pbs.twimg.com/media/a.jpg', 'https://example.com/a.jpg']
        with patch.object(embed_server, 'download_image', side_effect=download) as fetch, \
                patch.object(embed_server, '_image_model', Model()), \
                patch.object(embed_server, 'image_embedding_error', return_value=None):
            vectors = embed_server.embed_images(urls)
        self.assertEqual(fetch.call_count, 3)
        self.assertTrue(all(len(vector) == 512 for vector in vectors[:3]))
        self.assertEqual(vectors[3:], [None, None, None])


if __name__ == '__main__':
    unittest.main()
