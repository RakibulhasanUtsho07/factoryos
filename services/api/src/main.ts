import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import {
  resolveCorsOrigins,
  resolveSwaggerEnabled,
} from './config/runtime-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  const nodeEnv = configService.get<string>(
    'NODE_ENV',
    'development',
  );
  const corsOrigins = resolveCorsOrigins(
    nodeEnv,
    configService.get<string>('CORS_ORIGINS'),
  );

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.useGlobalInterceptors(
    new ApiResponseInterceptor(),
  );

  const swaggerEnabled = resolveSwaggerEnabled(
    nodeEnv,
    configService.get<string>('SWAGGER_ENABLED'),
  );

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('FactoryOS AI API')
      .setDescription('FactoryOS AI Manufacturing SaaS API')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(
      app,
      swaggerConfig,
    );

    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(port);
}

bootstrap();
