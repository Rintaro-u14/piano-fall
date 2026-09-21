import io
from pathlib import Path
from app import create_app


def test_upload_and_invalid_input(tmp_path):
    app=create_app(tmp_path)
    client=app.test_client()
    sample=Path(__file__).parents[1]/'samples'/'Aurora_Study.mid'
    response=client.post('/api/midi',data={'file':(io.BytesIO(sample.read_bytes()),'sample.mid')})
    assert response.status_code==200
    assert len(response.json['notes'])==73
    assert (tmp_path/'midi'/f'{response.json["id"]}.mid').exists()
    bad=client.post('/api/midi',data={'file':(io.BytesIO(b'invalid'),'bad.mid')})
    assert bad.status_code==400 and bad.json['error']
    nofont=client.post('/api/jobs',json={'songId':response.json['id'],'fontId':'missing','kind':'video'})
    assert nofont.status_code==400
    assert client.get('/api/status',headers={'Host':'evil.example'}).status_code==403
    assert client.post('/api/sample',headers={'Origin':'https://evil.example'}).status_code==403
    assert client.get('/api/files/audio/missing.wav').status_code==404
    app.extensions['pianofall']['executor'].shutdown()


def test_api_version_and_uploaded_score_endpoints(tmp_path):
    app=create_app(tmp_path);client=app.test_client()
    try:
        assert client.get('/api/status').json['apiVersion']==8
        sample=Path(__file__).parents[1]/'samples'/'Aurora_Study.mid'
        response=client.post('/api/midi',data={'file':(io.BytesIO(sample.read_bytes()),'uploaded.mid')})
        assert response.status_code==200
        sid=response.json['id']
        assert response.json['audioEvents']
        assert client.get(f'/api/music/{sid}').status_code==200
        assert client.get(f'/api/score/{sid}/0.png?part=auto').data.startswith(b'\x89PNG')
        missing=client.get('/api/not-available')
        assert missing.status_code==404 and '再起動' in missing.json['error']
        assert missing.json['path']=='/api/not-available'
    finally:
        app.extensions['pianofall']['executor'].shutdown()
