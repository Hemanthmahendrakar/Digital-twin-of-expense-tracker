pipeline {
    agent any

    environment {
        IMAGE_NAME = "hemanthkumarm3/digital-twin-of-expense-tracker"
    }

    stages {

        stage('Clone Repository') {
            steps {
                git branch: 'main',
                    url: 'https://github.com/Hemanthmahendrakar/Digital-twin-of-expense-tracker.git'
            }
        }

        stage('SonarQube Scan') {
            steps {
                script {
                    def scannerHome = tool 'sonar-scanner'

                    withSonarQubeEnv('sonarqube') {
                        sh """
                            ${scannerHome}/bin/sonar-scanner \
                              -Dsonar.projectKey=expense-tracker \
                              -Dsonar.sources=. \
                              -Dsonar.host.url=$SONAR_HOST_URL
                        """
                    }
                }
            }
        }

        stage('Docker Build') {
            steps {
                sh """
                    docker build -t ${IMAGE_NAME}:latest .
                """
            }
        }

        stage('Trivy Security Scan') {
            steps {
                sh """
                    docker run --rm \
                      -v /var/run/docker.sock:/var/run/docker.sock \
                      aquasec/trivy:latest image \
                      --severity HIGH,CRITICAL \
                      --exit-code 0 \
                      ${IMAGE_NAME}:latest
                """
            }
        }

        stage('Docker Login & Push') {
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'dockerhub-creds',
                        usernameVariable: 'DOCKER_USER',
                        passwordVariable: 'DOCKER_PASS'
                    )
                ]) {
                    sh """
                        echo "\$DOCKER_PASS" | docker login \
                          -u "\$DOCKER_USER" \
                          --password-stdin

                        docker push ${IMAGE_NAME}:latest

                        docker logout
                    """
                }
            }
        }
    }

    post {
        always {
            echo 'Pipeline execution completed.'
        }

        success {
            echo 'Docker image successfully pushed to Docker Hub.'
        }

        failure {
            echo 'Pipeline failed. Please check the logs.'
        }
    }
}
